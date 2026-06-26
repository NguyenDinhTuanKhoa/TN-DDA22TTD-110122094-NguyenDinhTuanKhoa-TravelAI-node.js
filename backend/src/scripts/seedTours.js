/**
 * seedTours.js — Migrate các tour cộng đồng hardcode (mảng COMMUNITY_TOURS trong
 * frontend/app/my-tours/page.tsx) vào MongoDB (collection `tours`).
 *
 * Bóc mảng trực tiếp từ page.tsx bằng bracket-matching (bỏ qua nội dung chuỗi) rồi
 * eval — tránh nhân đôi ~2000 dòng dữ liệu và luôn đồng bộ với nguồn.
 *
 * Chạy (từ thư mục backend/):
 *   node src/scripts/seedTours.js          # tạo tour còn thiếu, BỎ QUA tour đã có (theo slug)
 *   node src/scripts/seedTours.js --dry    # chỉ in số lượng + 1 mẫu, KHÔNG ghi DB
 *   node src/scripts/seedTours.js --force  # ghi đè cả tour đã tồn tại
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Tour = require('../models/Tour');

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const PAGE = path.resolve(__dirname, '../../../frontend/app/my-tours/page.tsx');

// Bóc mảng literal đứng sau `const COMMUNITY_TOURS ... = [` bằng cách đếm ngoặc [],
// bỏ qua mọi ký tự nằm trong chuỗi ('...', "...", `...`) và escape \.
function extractCommunityTours(src) {
  const mi = src.indexOf('const COMMUNITY_TOURS');
  if (mi === -1) throw new Error('Không tìm thấy COMMUNITY_TOURS trong page.tsx');
  // Tìm [ MỞ MẢNG sau dấu '=' — tránh khớp nhầm '[]' trong type annotation `Tour[]`.
  const eq = src.indexOf('=', mi);
  const start = src.indexOf('[', eq);
  if (eq === -1 || start === -1) throw new Error('Không tìm thấy dấu [ mở mảng');

  let depth = 0, inStr = null, esc = false, i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('Mảng không đóng ngoặc cân bằng — page.tsx thay đổi cấu trúc?');

  const arrText = src.slice(start, i);
  // Data tĩnh, tin cậy, nằm trong repo → eval an toàn để khỏi viết parser TS.
  // eslint-disable-next-line no-new-func
  return new Function(`return ${arrText};`)();
}

(async () => {
  const src = fs.readFileSync(PAGE, 'utf8');
  const tours = extractCommunityTours(src);
  console.log(`📦 Bóc được ${tours.length} tour từ page.tsx`);

  if (DRY) {
    const sample = tours[0];
    console.log('— Mẫu tour đầu tiên —');
    console.log(`  id=${sample.id} | "${sample.title}" | ${sample.stops?.length || 0} trạm | ${sample.reviews?.length || 0} review`);
    console.log('(--dry: không ghi DB)');
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Đã kết nối MongoDB');

  let created = 0, updated = 0, skipped = 0;
  for (const t of tours) {
    const { id, ...rest } = t;
    const existing = await Tour.findOne({ slug: id });
    if (existing && !FORCE) { skipped++; continue; }
    if (existing) {
      await Tour.updateOne({ slug: id }, { $set: { ...rest } });
      updated++;
    } else {
      await Tour.create({ ...rest, slug: id, source: 'seed' });
      created++;
    }
  }

  console.log(`\n🎉 Xong: +${created} tạo mới | ${updated} ghi đè | ${skipped} bỏ qua (đã có)`);
  console.log(`   Tổng tour trong DB: ${await Tour.countDocuments()}`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error('❌ Seed lỗi:', err);
  process.exit(1);
});
