// Lấy ảnh thật cho tour (ảnh bìa + ảnh từng trạm) qua Serper Images, có verify URL
// còn sống + fallback Unsplash theo category. Tái dùng cách làm của
// scripts/genMoreCommunityTours.js nhưng đóng gói để route admin gọi runtime.
const https = require('https');
const http = require('http');
const serperManager = require('./serperManager');

// Ảnh dự phòng theo category (Unsplash — luôn tải được) khi Serper không trả URL sống.
const FALLBACK = {
  beach: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=900&q=80',
  island: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=900&q=80',
  mountain: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=900&q=80',
  nature: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=900&q=80',
  heritage: 'https://images.unsplash.com/photo-1528127269322-539801943592?w=900&q=80',
  city: 'https://images.unsplash.com/photo-1583417319070-4a69db38a482?w=900&q=80',
  countryside: 'https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=900&q=80',
};
const FALLBACK_DEFAULT = FALLBACK.nature;

function checkImageUrl(url, timeoutMs = 3500) {
  return new Promise((resolve) => {
    try {
      const client = url.startsWith('https') ? https : http;
      const req = client.request(url, { method: 'GET', timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 400);
        res.destroy();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

// Trả URL ảnh sống đầu tiên cho `query`; nếu không có → fallback theo category.
async function firstValidImage(query, fallbackCategory) {
  try {
    const images = await serperManager.searchImages(query, 10);
    // Chỉ thử tối đa 6 URL đầu để không treo lâu khi gặp nhiều link chết.
    for (const url of images.slice(0, 6)) {
      if (await checkImageUrl(url)) return url;
    }
  } catch { /* ignore */ }
  return FALLBACK[fallbackCategory] || FALLBACK_DEFAULT;
}

// Chạy `fn` trên từng item với tối đa `limit` việc song song (pool đơn giản).
// Serper không có rate-limit nội bộ → giới hạn để tránh bắn quá nhiều request cùng lúc.
async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Điền coverImage + ảnh từng stop cho 1 tour draft (mutate & trả lại).
 * Bỏ qua trạm/cover đã có ảnh sẵn. Region/category dùng để chọn fallback.
 * Lấy ảnh SONG SONG (giới hạn concurrency) để không treo lâu khi tour nhiều trạm.
 */
async function fillTourImages(tour) {
  const region = tour.region || tour.title || 'Việt Nam';

  // Gom mọi việc cần fill thành danh sách task rồi chạy có giới hạn song song.
  const tasks = [];
  if (!tour.coverImage) {
    tasks.push({
      query: `${tour.title || region} du lịch cảnh đẹp`,
      category: 'nature',
      apply: (url) => { tour.coverImage = url; },
    });
  }
  if (Array.isArray(tour.stops)) {
    for (const stop of tour.stops) {
      if (stop.image) continue;
      tasks.push({
        query: `${stop.name || ''} ${stop.city || region}`.trim(),
        category: stop.category,
        apply: (url) => { stop.image = url; },
      });
    }
  }

  await mapLimit(tasks, 6, async (t) => { t.apply(await firstValidImage(t.query, t.category)); });

  return tour;
}

module.exports = { fillTourImages, firstValidImage, checkImageUrl, FALLBACK };
