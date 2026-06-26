const express = require('express');
const mongoose = require('mongoose');
const Tour = require('../models/Tour');
const { protect } = require('../middleware/auth');
const router = express.Router();

// Tìm tour theo slug (id cũ 'ct-N') hoặc _id — dùng chung cho GET chi tiết & review.
function tourQuery(id) {
  const or = [{ slug: id }];
  if (mongoose.Types.ObjectId.isValid(id)) or.push({ _id: id });
  return { $or: or, isPublished: true };
}

// Khởi tạo avatar từ tên: lấy ≤2 chữ cái đầu của các từ, viết hoa (vd "NK").
function initialsOf(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// ── Public: danh sách tour cộng đồng (cho /my-tours) ──────────────────────────
// Trả TẤT CẢ tour đã publish (≈37–50). Frontend tự lọc/sort client-side như cũ.
router.get('/', async (req, res) => {
  try {
    const { category, priceRange, search } = req.query;
    const query = { isPublished: true };
    if (category && category !== 'all') query.category = category;
    if (priceRange && priceRange !== 'all') query.priceRange = priceRange;
    if (search) query.title = { $regex: search, $options: 'i' };

    const tours = await Tour.find(query).sort({ viewCount: -1, createdAt: -1 });
    res.json({ success: true, data: tours.map((t) => t.toPublic()) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Public: chi tiết 1 tour (theo slug hoặc _id) + tăng lượt xem ──────────────
router.get('/:id', async (req, res) => {
  try {
    const tour = await Tour.findOneAndUpdate(
      tourQuery(req.params.id),
      { $inc: { viewCount: 1 } },
      { new: true }
    );
    if (!tour) return res.status(404).json({ success: false, message: 'Không tìm thấy tour' });

    res.json({ success: true, data: tour.toPublic() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Đăng/sửa đánh giá tour (cần đăng nhập) ────────────────────────────────────
// Mỗi user 1 đánh giá: đã có review cùng userId → cập nhật, chưa có → thêm mới.
// Sau đó tính lại rating trung bình + reviewCount của tour.
router.post('/:id/reviews', protect, async (req, res) => {
  try {
    const rating = Number(req.body.rating);
    const text = (req.body.text || '').toString().trim();
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Số sao phải từ 1 đến 5' });
    }

    const tour = await Tour.findOne(tourQuery(req.params.id));
    if (!tour) return res.status(404).json({ success: false, message: 'Không tìm thấy tour' });

    const now = new Date();
    const date = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    const existing = tour.reviews.find(
      (r) => r.userId && r.userId.toString() === req.user._id.toString()
    );
    if (existing) {
      existing.rating = rating;
      existing.text = text;
      existing.date = date;
      existing.name = req.user.name;
      existing.avatar = initialsOf(req.user.name);
    } else {
      tour.reviews.push({
        userId: req.user._id,
        name: req.user.name,
        avatar: initialsOf(req.user.name),
        date,
        rating,
        text,
        helpful: 0,
      });
    }

    // Tính lại điểm trung bình + số lượng từ toàn bộ review hiện có.
    const n = tour.reviews.length;
    const sum = tour.reviews.reduce((acc, r) => acc + (r.rating || 0), 0);
    tour.rating = n ? Number((sum / n).toFixed(1)) : 0;
    tour.reviewCount = n;

    await tour.save();
    res.status(201).json({ success: true, data: tour.toPublic() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
