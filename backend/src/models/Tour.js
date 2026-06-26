const mongoose = require('mongoose');

// Tour cộng đồng hiển thị ở /my-tours. Mirror của type `Tour` trong
// frontend/app/lib/savedTours.ts — GIỮ ĐỒNG BỘ THỦ CÔNG khi đổi cấu trúc.
// Trước đây các tour này hardcode trong frontend; nay lưu DB để admin CRUD + AI tạo.

const stopSchema = new mongoose.Schema({
  name: String,
  city: String,
  image: String,
  category: String,           // beach | mountain | nature | heritage | city | island | countryside...
  rating: { type: Number, default: 0 },
  description: String,
  // Toạ độ thật. Nếu thiếu, frontend (TourMap) tự geocode runtime qua Nominatim.
  coordinates: { lat: Number, lng: Number },
}, { _id: false });

const reviewSchema = new mongoose.Schema({
  // userId gắn chủ sở hữu review (cộng đồng nhập từ UI). Review seed/migrate cũ
  // không có userId. Dùng để thực thi 1-review/user (upsert) + nhận diện "của tôi".
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: String,
  avatar: String,
  date: String,               // chuỗi hiển thị, vd "04/2026"
  rating: { type: Number, default: 5 },
  text: String,
  helpful: { type: Number, default: 0 },
}, { _id: false });

const tourSchema = new mongoose.Schema({
  // Giữ id cũ 'ct-N' của các tour migrate để tương thích savedTours (localStorage
  // lưu theo `id`). Tour tạo mới không có slug → public API dùng _id.
  slug: { type: String, unique: true, sparse: true, index: true },

  title: { type: String, required: true },
  coverImage: String,
  duration: String,           // vd "2 ngày 1 đêm"
  days: { type: Number, default: 1 },

  category: String,           // nhãn hiển thị: "Biển", "Núi", "Di sản"...
  categoryIcon: { type: String, default: '📍' },
  region: String,             // "Miền Bắc", "Tây Nam Bộ"...

  priceRange: { type: String, enum: ['budget', 'mid-range', 'luxury'], default: 'mid-range' },
  priceLabel: { type: String, default: 'Liên hệ' },

  rating: { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  viewCount: { type: Number, default: 0 },

  tags: [String],
  highlights: [String],

  badge: String,
  badgeColor: { type: String, default: 'bg-sky-500' },

  author: { type: String, default: 'TravelAI' },
  authorAvatar: { type: String, default: 'AI' },
  completedDate: String,

  stops: [stopSchema],
  reviews: [reviewSchema],
  description: String,

  // Quản trị
  isPublished: { type: Boolean, default: true, index: true },
  source: { type: String, enum: ['seed', 'manual', 'ai'], default: 'manual' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// Chuẩn hoá tour về "public shape" cho frontend: id = slug || _id.
tourSchema.methods.toPublic = function () {
  const o = this.toObject();
  return {
    ...o,
    id: o.slug || o._id.toString(),
  };
};

module.exports = mongoose.model('Tour', tourSchema);
