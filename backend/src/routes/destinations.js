const express = require('express');
const Destination = require('../models/Destination');
const aiService = require('../services/aiService');
const { protect, admin } = require('../middleware/auth');
const router = express.Router();

// ── Lightweight: Lấy danh sách tên địa danh (cho frontend matching) ──────────
router.get('/names', async (req, res) => {
  try {
    const destinations = await Destination.find({}, 'name location.city').lean();
    res.json({
      success: true,
      data: destinations.map(d => ({ name: d.name, city: d.location?.city || '' }))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Lightweight: Dữ liệu tối giản cho bản đồ /explore ────────────────────────
// Chỉ trả về field bản đồ cần (toạ độ, tên, category, rating, ảnh đầu) + .lean()
// để tránh hydrate 5933 document. Cùng gzip → payload từ ~4.6MB còn vài trăm KB.
// Cache in-memory 5 phút: địa điểm gần như không đổi → mọi request sau trả tức thì,
// né round-trip tới Atlas (cloud) vốn tốn ~2-3s. Cache reset khi admin sửa địa điểm.
let mapCache = { data: null, ts: 0 };
const MAP_CACHE_TTL = 5 * 60 * 1000;
const invalidateMapCache = () => { mapCache = { data: null, ts: 0 }; };

router.get('/map', async (req, res) => {
  try {
    if (!mapCache.data || Date.now() - mapCache.ts > MAP_CACHE_TTL) {
      mapCache = {
        data: await Destination.find(
          { 'location.coordinates.lat': { $ne: null }, 'location.coordinates.lng': { $ne: null } },
          { name: 1, category: 1, rating: 1, reviewCount: 1, 'location.city': 1, 'location.coordinates': 1, images: { $slice: 3 } }
        ).lean(),
        ts: Date.now(),
      };
    }
    // Cho phép browser cache 5 phút (dữ liệu địa điểm thay đổi rất ít)
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, data: mapCache.data, total: mapCache.data.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Trích "điểm đến được nhắc đến" trong 1 đoạn text AI (cho card chat) ───────
// Khớp không phân biệt hoa/dấu + lõi tên + lọc theo tỉnh ngữ cảnh (xem aiService).
router.post('/from-text', async (req, res) => {
  try {
    const { text, question } = req.body;
    const data = await aiService.extractMentionedDestinations(text || '', 10, question || '');
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @swagger
 * /destinations:
 *   get:
 *     summary: Lấy danh sách điểm đến
 *     tags: [Destinations]
 *     parameters:
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *           enum: [beach, mountain, city, countryside, historical]
 *         description: Lọc theo danh mục
 *       - in: query
 *         name: priceRange
 *         schema:
 *           type: string
 *           enum: [budget, mid-range, luxury]
 *         description: Lọc theo mức giá
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Tìm kiếm theo tên
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Danh sách điểm đến
 */
// Get all destinations
router.get('/', async (req, res) => {
  try {
    const { category, priceRange, search, excludeCategories, isIconic, page = 1, limit = 50 } = req.query;
    const query = {};
    if (category) query.category = category;
    if (priceRange) query.priceRange = priceRange;
    if (excludeCategories) query.category = { $nin: excludeCategories.split(',') };
    if (isIconic === 'true') query.isIconic = true;
    
    // Cải thiện search: tìm theo name, location.city, description với hỗ trợ không dấu tiếng Việt
    let destinations = [];
    let total = 0;
    
    if (search) {
      // Hàm tạo regex cho phép tìm kiếm không phân biệt dấu
      const createDiacriticRegex = (str) => {
        return str.split('').map(char => {
          const map = {
            'a': '[aAàÀảẢãÃáÁạẠăĂằẰẳẲẵẴắẮặẶâÂầẦẩẨẫẪấẤậẬ]',
            'e': '[eEèÈẻẺẽẼéÉẹẸêÊềỀểỂễỄếẾệỆ]',
            'i': '[iIìÌỉỈĩĨíÍịỊ]',
            'o': '[oOòÒỏỎõÕóÓọỌôÔồỒổỔỗỖốỐộỘơƠờỜởỞỡỠớỚợỢ]',
            'u': '[uUùÙủỦũŨúÚụỤưƯừỪửỬữỮứỨựỰ]',
            'y': '[yYỳỲỷỶỹỸýÝỵỴ]',
            'd': '[dDđĐ]'
          };
          const baseChar = char.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
          // Escape special regex characters if not mapped
          if (map[baseChar]) return map[baseChar];
          return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('');
      };

      const regexPattern = createDiacriticRegex(search.trim());
      const regex = new RegExp(regexPattern, 'i');

      // Bước 1: Ưu tiên khớp chính xác tên địa điểm
      const exactMatches = await Destination.find({ ...query, name: regex }).sort({ rating: -1 }).lean();
      const seenIds = new Set(exactMatches.map(d => d._id.toString()));

      // Bước 2: Khớp tên thành phố
      const cityMatches = await Destination.find({ 
        ...query, 
        'location.city': regex, 
        _id: { $nin: Array.from(seenIds) } 
      }).sort({ rating: -1 }).lean();
      cityMatches.forEach(d => seenIds.add(d._id.toString()));

      // Bước 3: Khớp mô tả hoặc món ăn
      const otherMatches = await Destination.find({ 
        ...query, 
        $or: [
          { description: regex },
          { 'cuisine.name': regex }
        ],
        _id: { $nin: Array.from(seenIds) }
      }).sort({ rating: -1 }).lean();
      otherMatches.forEach(d => seenIds.add(d._id.toString()));

      // Bước 4: Hiển thị các địa điểm khác liên quan đến thành phố của kết quả chính (exactMatches)
      const relatedCities = [...new Set(exactMatches.map(d => d.location?.city).filter(Boolean))];
      let relatedMatches = [];
      if (relatedCities.length > 0) {
        relatedMatches = await Destination.find({ 
          ...query, 
          'location.city': { $in: relatedCities },
          _id: { $nin: Array.from(seenIds) }
        }).sort({ rating: -1 }).lean();
      }

      // Tổng hợp kết quả theo thứ tự ưu tiên
      const allResults = [...exactMatches, ...cityMatches, ...otherMatches, ...relatedMatches];
      
      total = allResults.length;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      destinations = allResults.slice(skip, skip + parseInt(limit));
    } else {
      destinations = await Destination.find(query)
        .sort({ iconicRank: 1, reviewCount: -1, rating: -1 })
        .limit(parseInt(limit))
        .skip((parseInt(page) - 1) * parseInt(limit));
      total = await Destination.countDocuments(query);
    }
    
    res.json({ 
      success: true,
      data: destinations, 
      totalPages: Math.ceil(total / limit), 
      currentPage: parseInt(page),
      total 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @swagger
 * /destinations/{id}:
 *   get:
 *     summary: Lấy chi tiết điểm đến
 *     tags: [Destinations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           example: 6784a1b2c3d4e5f678901234
 *         description: MongoDB ObjectId của điểm đến (24 ký tự hex)
 *     responses:
 *       200:
 *         description: Chi tiết điểm đến
 *       404:
 *         description: Không tìm thấy điểm đến
 *       500:
 *         description: ID không hợp lệ (phải là MongoDB ObjectId)
 */
// Get single destination
router.get('/:id', async (req, res) => {
  try {
    const destination = await Destination.findById(req.params.id);
    if (destination) {
      res.json({ success: true, data: destination });
    } else {
      res.status(404).json({ success: false, message: 'Destination not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @swagger
 * /destinations:
 *   post:
 *     summary: Tạo điểm đến mới (Admin)
 *     tags: [Destinations]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Destination'
 *     responses:
 *       201:
 *         description: Tạo thành công
 *       401:
 *         description: Chưa đăng nhập
 *       403:
 *         description: Không có quyền admin
 */
// Create destination (admin)
router.post('/', protect, admin, async (req, res) => {
  try {
    const destination = await Destination.create(req.body);
    invalidateMapCache();
    res.status(201).json({ success: true, data: destination });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @swagger
 * /destinations/{id}:
 *   put:
 *     summary: Cập nhật điểm đến (Admin)
 *     tags: [Destinations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Cập nhật thành công
 */
// Update destination (admin)
router.put('/:id', protect, admin, async (req, res) => {
  try {
    const destination = await Destination.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (destination) {
      invalidateMapCache();
      res.json({ success: true, data: destination });
    } else {
      res.status(404).json({ success: false, message: 'Destination not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete destination (admin)
router.delete('/:id', protect, admin, async (req, res) => {
  try {
    const destination = await Destination.findByIdAndDelete(req.params.id);
    if (destination) {
      invalidateMapCache();
      res.json({ success: true, message: 'Destination deleted' });
    } else {
      res.status(404).json({ success: false, message: 'Destination not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
