const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Destination = require('../models/Destination');
const Review = require('../models/Review');
const Itinerary = require('../models/Itinerary');
const Tour = require('../models/Tour');
const ChatHistory = require('../models/ChatHistory');
const AdminActivityLog = require('../models/AdminActivityLog');
const aiService = require('../services/aiService');
const { fillTourImages } = require('../utils/tourImages');
const { protect, admin } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLogger');
const router = express.Router();

// Tất cả routes đều cần admin
router.use(protect, admin);

// Helper: ép mảng ObjectId hợp lệ, bỏ qua id sai
const toValidIds = (ids) =>
  (Array.isArray(ids) ? ids : []).filter((id) => mongoose.Types.ObjectId.isValid(id));

// ============================================================
// DASHBOARD STATS — với analytics chi tiết
// ============================================================
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const daysParam = parseInt(req.query.days, 10);
    const days = Number.isFinite(daysParam) && daysParam >= 1 && daysParam <= 365 ? daysParam : 30;
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const rangeStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [users, destinations, reviews, itineraries] = await Promise.all([
      User.countDocuments(),
      Destination.countDocuments(),
      Review.countDocuments(),
      Itinerary.countDocuments(),
    ]);

    // Đếm trong 7 ngày gần đây để tính tăng trưởng (so với 7 ngày trước đó nữa)
    const [usersThisWeek, usersPrevWeek, reviewsThisWeek, reviewsPrevWeek] = await Promise.all([
      User.countDocuments({ createdAt: { $gte: weekAgo } }),
      User.countDocuments({
        createdAt: { $gte: new Date(weekAgo.getTime() - 7 * 24 * 60 * 60 * 1000), $lt: weekAgo },
      }),
      Review.countDocuments({ createdAt: { $gte: weekAgo } }),
      Review.countDocuments({
        createdAt: { $gte: new Date(weekAgo.getTime() - 7 * 24 * 60 * 60 * 1000), $lt: weekAgo },
      }),
    ]);

    const trend = (curr, prev) => {
      if (prev === 0) return curr > 0 ? 100 : 0;
      return Math.round(((curr - prev) / prev) * 100);
    };

    // User growth (theo days)
    const userGrowthRaw = await User.aggregate([
      { $match: { createdAt: { $gte: rangeStart } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Reviews over time (theo days)
    const reviewsOverTimeRaw = await Review.aggregate([
      { $match: { createdAt: { $gte: rangeStart } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Rating distribution
    const ratingDistRaw = await Review.aggregate([
      { $group: { _id: { $round: ['$rating', 0] }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const ratingDistribution = [1, 2, 3, 4, 5].map((r) => {
      const found = ratingDistRaw.find((x) => x._id === r);
      return { rating: r, count: found ? found.count : 0 };
    });

    // Top 5 destinations theo rating
    const topDestinations = await Destination.find()
      .sort({ rating: -1, reviewCount: -1 })
      .limit(5)
      .select('name rating reviewCount location.city images');

    // Destinations by category
    const destinationsByCategory = await Destination.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // Recent items
    const [recentUsers, recentReviews] = await Promise.all([
      User.find().sort({ createdAt: -1 }).limit(5).select('name email createdAt avatar'),
      Review.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('user', 'name')
        .populate('destination', 'name'),
    ]);

    res.json({
      range: { days, from: rangeStart.toISOString(), to: now.toISOString() },
      counts: { users, destinations, reviews, itineraries },
      trends: {
        users: trend(usersThisWeek, usersPrevWeek),
        reviews: trend(reviewsThisWeek, reviewsPrevWeek),
      },
      userGrowth: userGrowthRaw.map((x) => ({ date: x._id, count: x.count })),
      reviewsOverTime: reviewsOverTimeRaw.map((x) => ({ date: x._id, count: x.count })),
      ratingDistribution,
      topDestinations,
      destinationsByCategory: destinationsByCategory.map((x) => ({
        category: x._id || 'other',
        count: x.count,
      })),
      recentUsers,
      recentReviews,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// USERS MANAGEMENT
// ============================================================
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 10, search, role, status, dateFrom, dateTo } = req.query;
    const query = {};
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }
    if (role && role !== 'all') query.role = role;
    if (status === 'banned') query.isBanned = true;
    if (status === 'active') query.isBanned = { $ne: true };
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo) query.createdAt.$lte = new Date(dateTo);
    }

    const users = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await User.countDocuments(query);
    res.json({ users, total, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }
    if (req.params.id === String(req.user._id) && role !== 'admin') {
      return res.status(400).json({ message: 'Không thể tự hạ role của chính mình' });
    }
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true },
    ).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    logActivity(req, {
      action: 'role_change',
      targetModel: 'User',
      targetId: user._id,
      targetLabel: user.name,
      meta: { newRole: role },
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/users/:id/ban', async (req, res) => {
  try {
    if (req.params.id === String(req.user._id)) {
      return res.status(400).json({ message: 'Không thể tự khóa tài khoản chính mình' });
    }
    const { reason = '' } = req.body || {};
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isBanned: true, bannedAt: new Date(), banReason: reason },
      { new: true },
    ).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    logActivity(req, {
      action: 'ban',
      targetModel: 'User',
      targetId: user._id,
      targetLabel: user.name,
      meta: { reason },
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/users/:id/unban', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isBanned: false, bannedAt: null, banReason: '' },
      { new: true },
    ).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    logActivity(req, {
      action: 'unban',
      targetModel: 'User',
      targetId: user._id,
      targetLabel: user.name,
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/users/bulk', async (req, res) => {
  try {
    const ids = toValidIds(req.body?.ids).filter((id) => id !== String(req.user._id));
    if (ids.length === 0) {
      return res.status(400).json({ message: 'Không có id hợp lệ' });
    }
    const result = await User.deleteMany({ _id: { $in: ids } });
    logActivity(req, {
      action: 'bulk_delete',
      targetModel: 'User',
      meta: { count: result.deletedCount, ids },
    });
    res.json({ deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    if (req.params.id === String(req.user._id)) {
      return res.status(400).json({ message: 'Không thể tự xóa tài khoản chính mình' });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    logActivity(req, {
      action: 'delete',
      targetModel: 'User',
      targetId: user._id,
      targetLabel: user.name,
    });
    res.json({ message: 'User deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// DESTINATIONS MANAGEMENT
// ============================================================
router.get('/destinations', async (req, res) => {
  try {
    const { page = 1, limit = 10, search, category, region } = req.query;
    const query = {};
    if (search) query.name = { $regex: search, $options: 'i' };
    if (category && category !== 'all') query.category = category;
    if (region && region !== 'all') query['location.region'] = region;

    const destinations = await Destination.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Destination.countDocuments(query);
    res.json({ destinations, total, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/destinations', async (req, res) => {
  try {
    const destination = await Destination.create(req.body);
    logActivity(req, {
      action: 'create',
      targetModel: 'Destination',
      targetId: destination._id,
      targetLabel: destination.name,
    });
    res.status(201).json(destination);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/destinations/:id', async (req, res) => {
  try {
    const destination = await Destination.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!destination) return res.status(404).json({ message: 'Not found' });
    logActivity(req, {
      action: 'update',
      targetModel: 'Destination',
      targetId: destination._id,
      targetLabel: destination.name,
    });
    res.json(destination);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/destinations/bulk', async (req, res) => {
  try {
    const ids = toValidIds(req.body?.ids);
    if (ids.length === 0) return res.status(400).json({ message: 'Không có id hợp lệ' });
    const result = await Destination.deleteMany({ _id: { $in: ids } });
    await Review.deleteMany({ destination: { $in: ids } });
    logActivity(req, {
      action: 'bulk_delete',
      targetModel: 'Destination',
      meta: { count: result.deletedCount, ids },
    });
    res.json({ deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/destinations/:id', async (req, res) => {
  try {
    const destination = await Destination.findByIdAndDelete(req.params.id);
    if (!destination) return res.status(404).json({ message: 'Not found' });
    await Review.deleteMany({ destination: req.params.id });
    logActivity(req, {
      action: 'delete',
      targetModel: 'Destination',
      targetId: destination._id,
      targetLabel: destination.name,
    });
    res.json({ message: 'Destination deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// REVIEWS MANAGEMENT
// ============================================================
router.get('/reviews', async (req, res) => {
  try {
    const { page = 1, limit = 10, rating, destinationId, dateFrom, dateTo } = req.query;
    const query = {};
    if (rating) query.rating = parseInt(rating);
    if (destinationId && mongoose.Types.ObjectId.isValid(destinationId)) {
      query.destination = destinationId;
    }
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo) query.createdAt.$lte = new Date(dateTo);
    }

    const reviews = await Review.find(query)
      .populate('user', 'name email avatar')
      .populate('destination', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Review.countDocuments(query);
    res.json({ reviews, total, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

const recomputeDestinationRating = async (destinationId) => {
  if (!destinationId) return;
  const reviews = await Review.find({ destination: destinationId });
  const avgRating = reviews.length > 0
    ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
    : 0;
  await Destination.findByIdAndUpdate(destinationId, {
    rating: avgRating,
    reviewCount: reviews.length,
  });
};

router.delete('/reviews/bulk', async (req, res) => {
  try {
    const ids = toValidIds(req.body?.ids);
    if (ids.length === 0) return res.status(400).json({ message: 'Không có id hợp lệ' });
    const reviewsToDelete = await Review.find({ _id: { $in: ids } }).select('destination');
    const destinationIds = [...new Set(reviewsToDelete.map((r) => String(r.destination)))];
    const result = await Review.deleteMany({ _id: { $in: ids } });
    await Promise.all(destinationIds.map(recomputeDestinationRating));
    logActivity(req, {
      action: 'bulk_delete',
      targetModel: 'Review',
      meta: { count: result.deletedCount, ids },
    });
    res.json({ deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/reviews/:id', async (req, res) => {
  try {
    const review = await Review.findByIdAndDelete(req.params.id).populate('destination', 'name');
    if (!review) return res.status(404).json({ message: 'Not found' });
    await recomputeDestinationRating(review.destination?._id || review.destination);
    logActivity(req, {
      action: 'delete',
      targetModel: 'Review',
      targetId: review._id,
      targetLabel: review.destination?.name || '',
    });
    res.json({ message: 'Review deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// ITINERARIES MANAGEMENT
// ============================================================
router.get('/itineraries', async (req, res) => {
  try {
    const { page = 1, limit = 10, search, userId, status } = req.query;
    const query = {};
    if (search) query.title = { $regex: search, $options: 'i' };
    if (userId && mongoose.Types.ObjectId.isValid(userId)) query.user = userId;
    if (status && status !== 'all') query.status = status;

    const itineraries = await Itinerary.find(query)
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .select('-hotels -restaurants');

    const total = await Itinerary.countDocuments(query);
    res.json({ itineraries, total, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/itineraries/bulk', async (req, res) => {
  try {
    const ids = toValidIds(req.body?.ids);
    if (ids.length === 0) return res.status(400).json({ message: 'Không có id hợp lệ' });
    const result = await Itinerary.deleteMany({ _id: { $in: ids } });
    logActivity(req, {
      action: 'bulk_delete',
      targetModel: 'Itinerary',
      meta: { count: result.deletedCount, ids },
    });
    res.json({ deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/itineraries/:id', async (req, res) => {
  try {
    const itinerary = await Itinerary.findById(req.params.id)
      .populate('user', 'name email')
      .populate('destinations.destination', 'name images location');
    if (!itinerary) return res.status(404).json({ message: 'Not found' });
    res.json(itinerary);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/itineraries/:id', async (req, res) => {
  try {
    const itinerary = await Itinerary.findByIdAndDelete(req.params.id);
    if (!itinerary) return res.status(404).json({ message: 'Not found' });
    logActivity(req, {
      action: 'delete',
      targetModel: 'Itinerary',
      targetId: itinerary._id,
      targetLabel: itinerary.title,
    });
    res.json({ message: 'Itinerary deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// TOURS MANAGEMENT (tour cộng đồng /my-tours)
// ============================================================
router.get('/tours', async (req, res) => {
  try {
    const { page = 1, limit = 10, search, category, priceRange } = req.query;
    const query = {};
    if (search) query.title = { $regex: search, $options: 'i' };
    if (category && category !== 'all') query.category = category;
    if (priceRange && priceRange !== 'all') query.priceRange = priceRange;

    const tours = await Tour.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Tour.countDocuments(query);
    res.json({ tours, total, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/tours', async (req, res) => {
  try {
    const tour = await Tour.create({ ...req.body, createdBy: req.user._id, source: req.body.source || 'manual' });
    logActivity(req, {
      action: 'create',
      targetModel: 'Tour',
      targetId: tour._id,
      targetLabel: tour.title,
    });
    res.status(201).json(tour);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/tours/:id', async (req, res) => {
  try {
    // Không cho client ghi đè các field hệ thống.
    const { _id, slug, viewCount, createdBy, createdAt, ...update } = req.body;
    const tour = await Tour.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!tour) return res.status(404).json({ message: 'Not found' });
    logActivity(req, {
      action: 'update',
      targetModel: 'Tour',
      targetId: tour._id,
      targetLabel: tour.title,
    });
    res.json(tour);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/tours/bulk', async (req, res) => {
  try {
    const ids = toValidIds(req.body?.ids);
    if (ids.length === 0) return res.status(400).json({ message: 'Không có id hợp lệ' });
    const result = await Tour.deleteMany({ _id: { $in: ids } });
    logActivity(req, {
      action: 'bulk_delete',
      targetModel: 'Tour',
      meta: { count: result.deletedCount, ids },
    });
    res.json({ deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/tours/:id', async (req, res) => {
  try {
    const tour = await Tour.findByIdAndDelete(req.params.id);
    if (!tour) return res.status(404).json({ message: 'Not found' });
    logActivity(req, {
      action: 'delete',
      targetModel: 'Tour',
      targetId: tour._id,
      targetLabel: tour.title,
    });
    res.json({ message: 'Tour deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// AI tạo tour DRAFT (chưa lưu): sinh cấu trúc + fill ảnh thật qua Serper.
// Admin review/chỉnh rồi POST /tours để lưu. Thao tác có thể mất vài giây.
router.post('/tours/generate', async (req, res) => {
  try {
    const draft = await aiService.generateTour(req.body || {});
    try {
      await fillTourImages(draft);
    } catch (imgErr) {
      console.warn('[tours/generate] fillTourImages lỗi:', imgErr.message);
    }
    res.json({ success: true, data: { ...draft, source: 'ai' } });
  } catch (error) {
    console.error('[tours/generate] lỗi:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================
// CHAT HISTORY MANAGEMENT
// ============================================================
router.get('/chats', async (req, res) => {
  try {
    const { page = 1, limit = 10, search, userId } = req.query;
    const query = {};
    if (search) query.title = { $regex: search, $options: 'i' };
    if (userId && mongoose.Types.ObjectId.isValid(userId)) query.user = userId;

    const chatsRaw = await ChatHistory.find(query)
      .populate('user', 'name email')
      .sort({ lastMessage: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .select('title user lastMessage createdAt messages');

    const chats = chatsRaw.map((c) => ({
      _id: c._id,
      title: c.title,
      user: c.user,
      lastMessage: c.lastMessage,
      createdAt: c.createdAt,
      messageCount: c.messages?.length || 0,
    }));

    const total = await ChatHistory.countDocuments(query);
    res.json({ chats, total, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/chats/bulk', async (req, res) => {
  try {
    const ids = toValidIds(req.body?.ids);
    if (ids.length === 0) return res.status(400).json({ message: 'Không có id hợp lệ' });
    const result = await ChatHistory.deleteMany({ _id: { $in: ids } });
    logActivity(req, {
      action: 'bulk_delete',
      targetModel: 'ChatHistory',
      meta: { count: result.deletedCount, ids },
    });
    res.json({ deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/chats/:id', async (req, res) => {
  try {
    const chat = await ChatHistory.findById(req.params.id).populate('user', 'name email');
    if (!chat) return res.status(404).json({ message: 'Not found' });
    res.json(chat);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/chats/:id', async (req, res) => {
  try {
    const chat = await ChatHistory.findByIdAndDelete(req.params.id);
    if (!chat) return res.status(404).json({ message: 'Not found' });
    logActivity(req, {
      action: 'delete',
      targetModel: 'ChatHistory',
      targetId: chat._id,
      targetLabel: chat.title,
    });
    res.json({ message: 'Chat deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// ACTIVITY LOG
// ============================================================
router.get('/activity', async (req, res) => {
  try {
    const { page = 1, limit = 20, action, adminId, dateFrom, dateTo } = req.query;
    const query = {};
    if (action && action !== 'all') query.action = action;
    if (adminId && mongoose.Types.ObjectId.isValid(adminId)) query.admin = adminId;
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo) query.createdAt.$lte = new Date(dateTo);
    }

    const logs = await AdminActivityLog.find(query)
      .populate('admin', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await AdminActivityLog.countDocuments(query);
    res.json({ logs, total, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// GLOBAL SEARCH — tìm users, destinations, itineraries cùng lúc
// ============================================================
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) {
      return res.json({ users: [], destinations: [], itineraries: [] });
    }
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const limit = 5;

    const [users, destinations, itineraries] = await Promise.all([
      User.find({ $or: [{ name: rx }, { email: rx }] })
        .select('name email avatar role')
        .limit(limit),
      Destination.find({ name: rx })
        .select('name location.city images category')
        .limit(limit),
      Itinerary.find({ title: rx })
        .select('title startDate endDate')
        .limit(limit),
    ]);

    res.json({ users, destinations, itineraries });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ============================================================
// NOTIFICATIONS — activity logs gần nhất + count "mới" (chưa đọc)
// ============================================================
router.get('/notifications', async (req, res) => {
  try {
    const sinceParam = req.query.since;
    const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [recent, unreadCount] = await Promise.all([
      AdminActivityLog.find()
        .populate('admin', 'name')
        .sort({ createdAt: -1 })
        .limit(10),
      AdminActivityLog.countDocuments({ createdAt: { $gt: since } }),
    ]);

    res.json({ recent, unreadCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
