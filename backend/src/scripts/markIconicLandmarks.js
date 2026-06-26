require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Destination = require('../models/Destination');

// Map tỉnh → danh sách iconic landmarks (theo thứ tự ưu tiên).
// Mỗi entry: { patterns: [regex string...], rank: số nhỏ = ưu tiên cao }
const ICONIC_BY_PROVINCE = {
  // ── ĐỒNG BẰNG SÔNG HỒNG ─────────────────────────────────────────
  'Hà Nội': ['Hồ Gươm', 'Hồ Hoàn Kiếm', 'Lăng Bác', 'Lăng Chủ tịch', 'Văn Miếu', 'Hoàng Thành Thăng Long',
    'Chùa Một Cột', 'Nhà thờ Lớn Hà Nội', 'Phố cổ Hà Nội'],
  'Hải Phòng': ['Cát Bà', 'Đồ Sơn', 'Lan Hạ', 'Bạch Long Vĩ'],
  'Quảng Ninh': ['Vịnh Hạ Long', 'Hạ Long', 'Tuần Châu', 'Yên Tử', 'Bãi Cháy', 'Cô Tô'],
  'Ninh Bình': ['Tràng An', 'Tam Cốc', 'Bích Động', 'Bái Đính', 'Hang Múa', 'Nhà thờ Phát Diệm'],
  'Bắc Ninh': ['Đền Đô', 'Chùa Dâu', 'Chùa Bút Tháp', 'Lim'],
  'Hải Dương': ['Côn Sơn', 'Kiếp Bạc', 'Chí Linh'],
  'Hưng Yên': ['Phố Hiến', 'Đa Hòa', 'Chử Đồng Tử'],
  'Thái Bình': ['Chùa Keo', 'Đồng Châu', 'Cồn Vành'],
  'Hà Nam': ['Tam Chúc', 'Bát Cảnh Sơn', 'Ngũ Động Sơn'],
  'Nam Định': ['Phủ Dầy', 'Đền Trần', 'Hải Thịnh', 'Quất Lâm'],
  'Vĩnh Phúc': ['Tam Đảo', 'Tây Thiên', 'Đại Lải'],

  // ── ĐÔNG BẮC ────────────────────────────────────────────────────
  'Lào Cai': ['Fansipan', 'Sa Pa', 'Sapa', 'Ruộng bậc thang', 'Cát Cát', 'Y Tý', 'Bắc Hà'],
  'Hà Giang': ['Đồng Văn', 'Lũng Cú', 'Mã Pí Lèng', 'Mèo Vạc', 'Sông Nho Quế', 'Hoàng Su Phì'],
  'Cao Bằng': ['Bản Giốc', 'Ba Bể', 'Ngườm Ngao', 'Pác Bó'],
  'Bắc Kạn': ['Hồ Ba Bể', 'Ba Bể', 'Pù Luông'],
  'Lạng Sơn': ['Mẫu Sơn', 'Tam Thanh', 'Nhị Thanh', 'Chi Lăng'],
  'Bắc Giang': ['Tây Yên Tử', 'Khuôn Thần', 'Suối Mỡ'],
  'Thái Nguyên': ['Hồ Núi Cốc', 'Tân Cương', 'Phượng Hoàng'],
  'Tuyên Quang': ['Tân Trào', 'Na Hang', 'Mỹ Lâm'],
  'Phú Thọ': ['Đền Hùng', 'Xuân Sơn', 'Ao Châu'],

  // ── TÂY BẮC ─────────────────────────────────────────────────────
  'Yên Bái': ['Mù Cang Chải', 'Khau Phạ', 'Tú Lệ', 'Suối Giàng', 'Thác Bà'],
  'Sơn La': ['Mộc Châu', 'Đồi chè', 'Dải Yếm', 'Pha Đin', 'Tà Xùa'],
  'Hòa Bình': ['Mai Châu', 'Bản Lác', 'Hồ Hòa Bình', 'Thung Nai'],
  'Điện Biên': ['Điện Biên Phủ', 'A1', 'Mường Thanh', 'Pa Khoang'],
  'Lai Châu': ['Pu Ta Leng', 'Sìn Hồ', 'Tà Tổng'],

  // ── BẮC TRUNG BỘ ────────────────────────────────────────────────
  'Thanh Hóa': ['Sầm Sơn', 'Pù Luông', 'Lam Kinh', 'Hàm Rồng', 'Bến En'],
  'Nghệ An': ['Cửa Lò', 'Kim Liên', 'Pù Mát', 'Quê Bác'],
  'Hà Tĩnh': ['Thiên Cầm', 'Hương Tích', 'Đèo Ngang', 'Vũng Áng'],
  'Quảng Bình': ['Phong Nha', 'Sơn Đoòng', 'Thiên Đường', 'Nhật Lệ', 'Hang Én'],
  'Quảng Trị': ['Cồn Cỏ', 'Cửa Tùng', 'Vĩnh Mốc', 'Thành cổ Quảng Trị', 'Khe Sanh'],
  'Thừa Thiên Huế': ['Đại Nội', 'Lăng Khải Định', 'Lăng Tự Đức', 'Lăng Minh Mạng', 'Thiên Mụ',
    'Kinh thành Huế', 'Bạch Mã', 'Lăng Cô'],

  // ── DUYÊN HẢI NAM TRUNG BỘ ──────────────────────────────────────
  'Quảng Nam': ['Hội An', 'Mỹ Sơn', 'Cù Lao Chàm'],
  'Đà Nẵng': ['Bà Nà', 'Cầu Vàng', 'Ngũ Hành Sơn', 'Sơn Trà', 'Cầu Rồng', 'Mỹ Khê'],
  'Quảng Ngãi': ['Lý Sơn', 'Sa Huỳnh', 'Mỹ Khê Quảng Ngãi', 'Ba Làng An'],
  'Bình Định': ['Quy Nhơn', 'Kỳ Co', 'Eo Gió', 'Ghềnh Ráng', 'Hầm Hô'],
  'Phú Yên': ['Gành Đá Đĩa', 'Vũng Rô', 'Mũi Điện', 'Tuy Hòa', 'Bãi Xép'],
  'Khánh Hòa': ['Vinpearl', 'Nha Trang', 'Ponagar', 'Hòn Tre', 'Hòn Mun', 'Dốc Lết', 'Vịnh Vân Phong'],
  'Ninh Thuận': ['Vĩnh Hy', 'Hang Rái', 'Pô Klong Garai', 'Mũi Dinh', 'Bình Tiên'],
  'Bình Thuận': ['Mũi Né', 'Đồi cát', 'White Sand', 'Bàu Trắng', 'Kê Gà', 'Phú Quý', 'Tà Cú'],

  // ── TÂY NGUYÊN ──────────────────────────────────────────────────
  'Kon Tum': ['Măng Đen', 'Ngọc Linh', 'Đăk Bla'],
  'Gia Lai': ['Pleiku', 'Biển Hồ', 'Hàm Rồng Gia Lai', 'Chư Đăng Ya'],
  'Đắk Lắk': ['Buôn Ma Thuột', 'Buôn Đôn', 'Lắk', 'Dray Nur', 'Dray Sap'],
  'Đắk Nông': ['Tà Đùng', 'Liêng Nung', 'Đray Sáp'],
  'Lâm Đồng': ['Xuân Hương', 'Datanla', 'Crazy House', 'Hằng Nga', 'Tuyền Lâm', 'Langbiang',
    'Đà Lạt', 'Pongour', 'Prenn'],

  // ── ĐÔNG NAM BỘ ─────────────────────────────────────────────────
  'Hồ Chí Minh': ['Nhà thờ Đức Bà', 'Dinh Độc Lập', 'Bến Thành', 'Bưu điện', 'Bitexco',
    'Landmark 81', 'Địa đạo Củ Chi', 'Bảo tàng Chứng tích'],
  'Bình Dương': ['Đại Nam', 'Núi Cậu', 'Dầu Tiếng'],
  'Đồng Nai': ['Nam Cát Tiên', 'Bửu Long', 'Trị An', 'Long Khánh'],
  'Tây Ninh': ['Bà Đen', 'Cao Đài', 'Dầu Tiếng Tây Ninh', 'Lò Gò'],
  'Bình Phước': ['Bù Gia Mập', 'Sóc Bom Bo', 'Tà Thiết'],
  'Bà Rịa - Vũng Tàu': ['Tượng Chúa', 'Bãi Sau', 'Côn Đảo', 'Hồ Tràm', 'Bãi Trước',
    'Hải Đăng Vũng Tàu', 'Long Hải'],

  // ── ĐỒNG BẰNG SÔNG CỬU LONG ────────────────────────────────────
  'Long An': ['Tân Lập', 'Đồng Tháp Mười Long An'],
  'Tiền Giang': ['Cái Bè', 'Thới Sơn', 'Đồng Tâm', 'Gò Công'],
  'Bến Tre': ['Cồn Phụng', 'Cồn Quy', 'Vàm Hồ', 'Cái Mơn'],
  'Trà Vinh': ['Ao Bà Om', 'Ba Động', 'Chùa Âng', 'Vàm Ray', 'Chùa Cò', 'Hang Dơi'],
  'Vĩnh Long': ['An Bình', 'Vinh Sang', 'Văn Thánh Miếu'],
  'Đồng Tháp': ['Sa Đéc', 'Tràm Chim', 'Gáo Giồng', 'Xẻo Quýt'],
  'An Giang': ['Núi Cấm', 'Núi Sam', 'Châu Đốc', 'Tà Pạ', 'Trà Sư', 'Bảy Núi'],
  'Kiên Giang': ['Phú Quốc', 'Vinpearl Safari', 'Hòn Thơm', 'Bãi Sao', 'Dinh Cậu', 'Hà Tiên', 'Nam Du'],
  'Cần Thơ': ['Cái Răng', 'Chùa Khmer', 'Bến Ninh Kiều', 'Phong Điền'],
  'Hậu Giang': ['Lung Ngọc Hoàng', 'Tầm Vu', 'Vị Thanh'],
  'Sóc Trăng': ['Chùa Dơi', 'Chùa Đất Sét', 'Chùa Kh\'leang', 'Bãi Biển Hồ Bể'],
  'Bạc Liêu': ['Cao Đẳng Bạc Liêu', 'Cánh đồng điện gió', 'Nhà Công Tử Bạc Liêu', 'Quan Âm Phật Đài'],
  'Cà Mau': ['Đất Mũi', 'U Minh', 'Hòn Đá Bạc', 'Khai Long'],
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function markIconic() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  // Reset trước
  await Destination.updateMany({}, { $set: { isIconic: false, iconicRank: 999 } });
  console.log('🔄 Reset all isIconic = false');

  let totalMarked = 0;
  const summary = [];

  for (const [province, landmarks] of Object.entries(ICONIC_BY_PROVINCE)) {
    const cityRegex = new RegExp(escapeRegex(province), 'i');
    let provinceCount = 0;

    for (let i = 0; i < landmarks.length; i++) {
      const landmark = landmarks[i];
      const rank = i + 1; // 1 = nổi tiếng nhất
      const nameRegex = new RegExp(escapeRegex(landmark), 'i');

      const result = await Destination.updateMany(
        {
          name: nameRegex,
          $or: [
            { 'location.city': cityRegex },
            { 'location.country': cityRegex }
          ]
        },
        { $set: { isIconic: true, iconicRank: rank } }
      );

      if (result.modifiedCount > 0) {
        provinceCount += result.modifiedCount;
        console.log(`  ✓ ${province} | rank ${rank} | "${landmark}" → ${result.modifiedCount} docs`);
      }
    }

    totalMarked += provinceCount;
    summary.push({ province, marked: provinceCount });
  }

  console.log('\n📊 Tổng kết:');
  summary.filter(s => s.marked > 0).forEach(s => console.log(`  ${s.province}: ${s.marked}`));
  console.log(`\n🎯 Tổng số iconic destinations: ${totalMarked}`);

  await mongoose.disconnect();
  process.exit(0);
}

markIconic().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
