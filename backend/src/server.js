const express = require('express');
const http = require('http');
const cors = require('cors');
const compression = require('compression');
const dotenv = require('dotenv');
const swaggerUi = require('swagger-ui-express');
const connectDB = require('./config/db');
const swaggerSpec = require('./swagger');
const { initSocket } = require('./socket');

dotenv.config();

const app = express();

// Connect to MongoDB
connectDB();

// ── CORS: allowlist từ env CLIENT_URL (phân cách bằng dấu phẩy) ──────────────
// Nếu CLIENT_URL không set → cho phép tất cả (hành vi cũ) + cảnh báo. Đặt CLIENT_URL
// ở production để chỉ frontend hợp lệ gọi được API.
const allowedOrigins = (process.env.CLIENT_URL || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn('[CORS] CLIENT_URL chưa được set → đang cho phép TẤT CẢ origin. Hãy set CLIENT_URL ở production.');
}

const corsOptions = {
  origin: (origin, callback) => {
    // Không có origin (curl, mobile app, server-to-server) → cho qua
    if (!origin) return callback(null, true);
    // Chưa cấu hình allowlist → cho qua tất cả (giữ hành vi cũ)
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin ${origin} không được phép`));
  },
  credentials: true,
};

// Middleware
// Nén gzip toàn bộ response (JSON nén được ~85-90%). Payload lớn như
// /destinations (4.6MB) giảm còn vài trăm KB → tăng tốc tải bản đồ rõ rệt.
app.use(compression());
app.use(cors(corsOptions));
app.use(express.json());

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'TravelAI API Documentation'
}));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/destinations', require('./routes/destinations'));
app.use('/api/itineraries', require('./routes/itineraries'));
app.use('/api/tours', require('./routes/tours'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/recommendations', require('./routes/recommendations'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/weather', require('./routes/weather'));
app.use('/api/saved', require('./routes/saved'));
app.use('/api/specialties', require('./routes/specialties'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/chat', require('./routes/chat'));

app.get('/', (req, res) => {
  res.json({ message: 'TravelAI API is running', docs: '/api-docs' });
});

// Initialize Cron Jobs
require('./cron/fetchDestinations');

const PORT = process.env.PORT || 5000;
const httpServer = http.createServer(app);
initSocket(httpServer);
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
