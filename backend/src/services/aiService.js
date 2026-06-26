const OpenAI = require('openai');
const User = require('../models/User');
const Itinerary = require('../models/Itinerary');
const Destination = require('../models/Destination');
const ProvinceSpecialty = require('../models/ProvinceSpecialty');
const routingService = require('./routingService');
const searchService = require('./searchService');
const { MERGER_CONTEXT_BLOCK, RESTRUCTURED_NAMES, MERGER_KEYWORDS } = require('../data/provinceMergers');

const opencodeClient = new OpenAI({
  baseURL: 'https://opencode.ai/zen/v1',
  apiKey: process.env.OPENCODE_API_KEY,
  timeout: 45 * 1000,
  maxRetries: 0,
});
const nvidiaClient = new OpenAI({
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: process.env.NVIDIA_API_KEY,
  timeout: 60 * 1000,
  maxRetries: 2,
});
const OPENCODE_MODEL = 'mimo-v2.5-free';
const NVIDIA_MODEL_PRIMARY = 'stepfun-ai/step-3.7-flash';
const NVIDIA_MODEL_FALLBACK = 'minimaxai/minimax-m2.7';

// Token tối đa mỗi phản hồi. step-3.7-flash là model reasoning → cần dư token cho cả
// phần <think> lẫn câu trả lời; nếu thấp (4096) câu trả lời bị cắt giữa chừng hoặc rỗng.
const MAX_TOKENS = 8192;

// Tạo tour là one-shot sinh JSON dày (nhiều trạm + review) → cần dư token hơn chat
// để tránh JSON bị cắt giữa chừng (parse lỗi). Cao hơn MAX_TOKENS vì không streaming.
const MAX_TOKENS_TOUR = 16384;

// Model reasoning trên NVIDIA: nếu không giới hạn reasoning_effort, phần <think> ngốn hết
// max_tokens → câu trả lời rỗng/cụt. 'low' giảm mạnh reasoning, dồn token cho đáp án.
// (Đã kiểm chứng: chat_template_kwargs.thinking/enable_thinking và /no_think đều bị NVIDIA bỏ qua.)
const REASONING_MODELS = new Set([NVIDIA_MODEL_PRIMARY, NVIDIA_MODEL_FALLBACK]);

// ── Sliding window: chỉ gửi N message CUỐI lên model để tránh token phình ─────
// buildSystemPrompt đã giữ context quan trọng (vùng, sở thích, điểm đến) trong system
// prompt → cắt message không mất ngữ cảnh. Mỗi cặp user+assistant = 2 messages.
const MAX_CHAT_WINDOW = 12;  // ~6 lượt hội thoại gần nhất

// Gắn model + reasoning_effort phù hợp vào params trước khi gọi API
function withModel(baseParams, model) {
  const params = { ...baseParams, model };
  if (REASONING_MODELS.has(model)) params.reasoning_effort = 'low';
  return params;
}

const SYSTEM_PROMPT = `Bạn là TravelAI - trợ lý du lịch thông minh của Việt Nam.

**QUY TẮC QUAN TRỌNG - BẮT BUỘC TUÂN THỦ:**
1. CHỈ đưa ra thông tin CHÍNH XÁC, dựa trên dữ liệu có sẵn trong hệ thống
2. KHÔNG bịa đặt tên địa điểm, khách sạn, nhà hàng, món ăn, đặc sản không có thật
3. Nếu KHÔNG chắc chắn về thông tin → HÃY NÓI "Tôi không có thông tin chính xác" thay vì đoán
4. Khi được cung cấp danh sách điểm đến từ hệ thống → CHỈ gợi ý từ danh sách đó
5. Khi được cung cấp danh sách đặc sản từ hệ thống → CHỈ gợi ý từ danh sách đó
6. KHÔNG nhầm lẫn địa điểm giữa các tỉnh/thành phố
7. KHÔNG nhầm lẫn đặc sản giữa các tỉnh/thành phố

**NHIỆM VỤ:**
- Tư vấn du lịch Việt Nam với thông tin CHÍNH XÁC
- Đề xuất lịch trình chi tiết theo ngày
- Tư vấn món ăn và đặc sản của từng tỉnh/thành phố
- Ước tính ngân sách bằng VNĐ
- Trả lời bằng tiếng Việt, thân thiện và hữu ích

**ƯU TIÊN:** Sử dụng thông tin từ [DANH SÁCH ĐIỂM ĐẾN] và [ĐẶC SẢN ĐỊA PHƯƠNG] bên dưới nếu có.`;

// Instruction bổ sung khi user hỏi về lịch trình — yêu cầu AI trả về JSON block ẩn
const ITINERARY_JSON_INSTRUCTION = `

**KHI NGƯỜI DÙNG MUỐN LỊCH TRÌNH:** Nếu người dùng đã cho biết khu vực / số ngày / sở thích → HÃY TẠO NGAY lịch trình chi tiết theo từng ngày từ các điểm đến trong context bên trên. Bạn LUÔN có thể tự dựng lịch trình từ danh sách điểm đến đã cung cấp — KHÔNG được trả lời "chưa có tour" hay từ chối, và KHÔNG lặp lại câu trả lời ở lượt trước.

**QUAN TRỌNG - KHI TẠO LỊCH TRÌNH:** Sau phần lịch trình markdown, hãy thêm một block JSON ẩn theo định dạng CHÍNH XÁC này (trên một dòng riêng, không thêm text gì):
\`\`\`json_itinerary
{"destinations":["Tên địa điểm 1","Tên địa điểm 2"],"days":N,"budget":"X triệu VNĐ","summary":"Mô tả ngắn 1 câu"}
\`\`\`
Chỉ liệt kê tên địa điểm thực sự (địa danh, không phải hoạt động). Đây là dữ liệu để hệ thống tự động lưu lịch trình.`;

// ── Định nghĩa field cho form làm rõ yêu cầu (clarification) ────────────────
// Form do backend dựng tất định (không gọi model). buildClarificationBlock()
// chọn các field còn THIẾU từ đây. location + interests luôn hiện; days/budget
// chỉ hiện khi user chưa nhắc tới.
const CLARIFY_FIELDS = {
  location: {
    key: 'location',
    label: 'Bạn muốn đi đâu?',
    type: 'region',
    required: true,
    allowCustom: true,
    placeholder: 'Nhập tỉnh/thành phố (vd: Đà Nẵng, Phú Quốc...)',
    options: [
      { value: 'Miền Bắc', label: 'Miền Bắc', icon: '⛰️' },
      { value: 'Miền Trung', label: 'Miền Trung', icon: '🏖️' },
      { value: 'Tây Nguyên', label: 'Tây Nguyên', icon: '🌄' },
      { value: 'Miền Nam', label: 'Miền Nam', icon: '🌴' },
      { value: 'Đà Nẵng', label: 'Đà Nẵng', icon: '🌉' },
      { value: 'Đà Lạt', label: 'Đà Lạt', icon: '🌲' },
      { value: 'Phú Quốc', label: 'Phú Quốc', icon: '🏝️' },
      { value: 'Sa Pa', label: 'Sa Pa', icon: '🏔️' },
      { value: 'Hội An', label: 'Hội An', icon: '🏮' },
      { value: 'Nha Trang', label: 'Nha Trang', icon: '🐚' },
    ],
  },
  days: {
    key: 'days',
    label: 'Đi mấy ngày?',
    type: 'select',
    required: false,
    allowCustom: true,
    options: [
      { value: '2', label: '2 ngày' },
      { value: '3', label: '3 ngày' },
      { value: '4', label: '4 ngày' },
      { value: '5', label: '5 ngày' },
      { value: '7', label: '1 tuần' },
    ],
  },
  budget: {
    key: 'budget',
    label: 'Ngân sách dự kiến?',
    type: 'select',
    required: false,
    allowCustom: true,
    options: [
      { value: '3 triệu', label: '~3 triệu' },
      { value: '5 triệu', label: '~5 triệu' },
      { value: '10 triệu', label: '~10 triệu' },
      { value: '15 triệu', label: 'trên 15 triệu' },
    ],
  },
  people: {
    key: 'people',
    label: 'Đi mấy người?',
    type: 'select',
    required: false,
    allowCustom: true,
    placeholder: 'Số người cụ thể (vd: 4 người)',
    options: [
      { value: 'một mình', label: 'Một mình', icon: '🧍' },
      { value: '2 người', label: 'Cặp đôi', icon: '💑' },
      { value: 'gia đình', label: 'Gia đình', icon: '👨‍👩‍👧' },
      { value: 'nhóm bạn', label: 'Nhóm bạn', icon: '👥' },
    ],
  },
  interests: {
    key: 'interests',
    label: 'Bạn thích gì? (chọn nhiều)',
    type: 'multiselect',
    required: false,
    options: [
      { value: 'biển', label: 'Biển', icon: '🏖️' },
      { value: 'núi', label: 'Núi', icon: '⛰️' },
      { value: 'ẩm thực', label: 'Ẩm thực', icon: '🍜' },
      { value: 'văn hóa', label: 'Văn hóa', icon: '🏛️' },
      { value: 'nghỉ dưỡng', label: 'Nghỉ dưỡng', icon: '🧘' },
      { value: 'khám phá', label: 'Khám phá', icon: '🧭' },
      { value: 'vui chơi', label: 'Vui chơi', icon: '🎡' },
      { value: 'chụp ảnh', label: 'Chụp ảnh', icon: '📸' },
      { value: 'lãng mạn', label: 'Lãng mạn', icon: '💕' },
      { value: 'cắm trại', label: 'Dã ngoại', icon: '🏕️' },
    ],
  },
};

// ── Loại hình chuyến đi (cho form làm rõ THÍCH ỨNG) ─────────────────────────
// Khi user nêu LOẠI HÌNH nhưng chưa có địa điểm ("đi biển", "tuần trăng mật",
// "dã ngoại"...), detectTripType() khớp keyword (đã bỏ dấu) để cá nhân hóa form:
// lời mở đầu riêng + tự tích sẵn `interests` + `defaults` (vd trăng mật → cặp đôi).
// Việc nhận diện này còn vá 2 lỗ hổng: (1) câu kiểu "đi dã ngoại" không qua được
// hasTravelIntent; (2) cụm "tuần trăng mật"/"leo núi" bị tưởng là TÊN ĐỊA DANH.
// THỨ TỰ QUAN TRỌNG: loại đặc thù đứng TRƯỚC, 'beach' để CUỐI vì keyword 'bien' rộng nhất.
const TRIP_TYPES = [
  { type: 'honeymoon', keywords: ['tuan trang mat', 'trang mat', 'honeymoon'],
    intro: '💕 Tuần trăng mật lãng mạn! Cho mình hỏi vài ý để gợi ý nơi phù hợp nhất nhé 👇',
    interests: ['nghỉ dưỡng', 'lãng mạn'], defaults: { people: '2 người' } },
  { type: 'mountain', keywords: ['leo nui', 'len nui', 'trekking', 'trek', 'san may', 'chinh phuc'],
    intro: '⛰️ Mê núi rừng hả! Chọn giúp mình vài thông tin để gợi ý cung đường hợp ý nhé 👇',
    interests: ['núi'] },
  { type: 'camping', keywords: ['cam trai', 'camping', 'glamping'],
    intro: '🏕️ Đi cắm trại thì tuyệt! Cho mình vài thông tin để gợi ý điểm cắm trại phù hợp nhé 👇',
    interests: ['cắm trại'] },
  { type: 'picnic', keywords: ['da ngoai', 'picnic'],
    intro: '🧺 Một chuyến dã ngoại thư giãn! Chọn giúp mình vài ý để gợi ý nơi phù hợp nhé 👇',
    interests: ['cắm trại'] },
  { type: 'phuot', keywords: ['phuot', 'xuyen viet', 'road trip'],
    intro: '🏍️ Tâm hồn phượt thủ! Cho mình vài thông tin để gợi ý cung đường khám phá nhé 👇',
    interests: ['khám phá'] },
  { type: 'foodie', keywords: ['tour am thuc', 'food tour'],
    intro: '🍜 Đi ăn sập đường luôn! Chọn giúp mình vài ý để gợi ý thiên đường ẩm thực nhé 👇',
    interests: ['ẩm thực'] },
  { type: 'resort', keywords: ['nghi duong', 'resort', 'an duong', 'thu gian'],
    intro: '🧘 Cần nghỉ dưỡng thư giãn! Cho mình vài thông tin để gợi ý nơi chill hợp ý nhé 👇',
    interests: ['nghỉ dưỡng'] },
  { type: 'beach', keywords: ['di bien', 'tam bien', 'ra bien', 'bai bien', 'lan bien', 'san ho', 'bien'],
    intro: '🏖️ Bạn muốn đi biển! Chọn giúp mình vài thông tin để gợi ý bãi biển hợp ý nhé 👇',
    interests: ['biển'] },
];

// ── Mapping tỉnh/vùng miền để lọc context ──────────────────────────────────
const REGION_KEYWORDS = {
  'Miền Bắc': ['hà nội', 'hà giang', 'cao bằng', 'bắc kạn', 'tuyên quang', 'lào cai', 'yên bái', 'thái nguyên',
    'lạng sơn', 'quảng ninh', 'bắc giang', 'phú thọ', 'vĩnh phúc', 'bắc ninh', 'hải dương', 'hải phòng',
    'hưng yên', 'thái bình', 'hà nam', 'nam định', 'ninh bình', 'hòa bình', 'sơn la', 'điện biên',
    'lai châu', 'sapa', 'sa pa', 'hạ long', 'vịnh hạ long', 'bản giốc', 'mộc châu', 'mai châu', 'tam cốc', 'tràng an'],
  'Miền Trung': ['thanh hóa', 'nghệ an', 'hà tĩnh', 'quảng bình', 'quảng trị', 'thừa thiên huế', 'huế',
    'đà nẵng', 'quảng nam', 'hội an', 'quảng ngãi', 'bình định', 'quy nhơn', 'phú yên', 'khánh hòa',
    'nha trang', 'ninh thuận', 'bình thuận', 'phan thiết', 'mũi né', 'phong nha'],
  'Tây Nguyên': ['kon tum', 'gia lai', 'pleiku', 'đắk lắk', 'buôn ma thuột', 'đắk nông', 'lâm đồng', 'đà lạt'],
  'Miền Nam': ['hồ chí minh', 'sài gòn', 'bình dương', 'bình phước', 'tây ninh', 'đồng nai', 'bà rịa', 'vũng tàu', 'long an',
    'tiền giang', 'bến tre', 'trà vinh', 'vĩnh long', 'đồng tháp', 'an giang', 'châu đốc', 'kiên giang',
    'phú quốc', 'cần thơ', 'hậu giang', 'sóc trăng', 'bạc liêu', 'cà mau', 'cần thơ', 'côn đảo',
    'hà tiên', 'châu đốc', 'cù lao', 'miền tây'],
};

// Detect vùng/tỉnh từ query người dùng
// Dịch chuyển detectRegionFromQuery vào trong class AIService để gọi hàm async

// Detect xem user đang TÌM tour có sẵn (không phải tạo mới)
function detectTourSearchQuery(messages) {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'user') return false;
  const text = lastMsg.content.toLowerCase();
  const searchPhrases = [
    'có tour nào', 'tìm tour', 'tour nào', 'có chuyến nào', 'có lịch trình nào',
    'tour có sẵn', 'xem tour', 'danh sách tour', 'tour nào phù hợp', 'gợi ý tour',
    'có tour', 'tour đi', 'tour biển', 'tour núi',
  ];
  return searchPhrases.some(p => text.includes(p));
}

// Detect xem user có hỏi về lịch trình không (tạo mới). Phân tầng tín hiệu thay vì
// "1 keyword bất kỳ là đủ" (cũ) — tránh nhồi ITINERARY_JSON_INSTRUCTION vào MỌI lượt
// chỉ vì câu chứa "du lịch"/"gợi ý"/"ngày".
function detectItineraryQuery(messages) {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'user') return false;
  // Nếu chỉ đang TÌM tour có sẵn → không bật chế độ tạo lịch trình mới
  if (detectTourSearchQuery(messages)) return false;
  const text = lastMsg.content.toLowerCase();

  // Tín hiệu MẠNH: user nói thẳng muốn lịch trình/kế hoạch → 1 cái là đủ
  const strong = ['lịch trình', 'itinerary', 'kế hoạch', 'lên lịch', 'hành trình', 'plan'];
  if (strong.some(k => text.includes(k))) return true;

  // Tín hiệu THỜI LƯỢNG: "N ngày/đêm" hoặc "cuối tuần" — trong chatbot du lịch gần như
  // luôn nghĩa là muốn dựng lịch trình. Loại trừ câu hỏi tra cứu thời gian (thời tiết...).
  const hasDuration = /\d+\s*(ngày|đêm)\b/.test(text) || text.includes('cuối tuần');
  if (hasDuration) {
    const factualTiming = /thời tiết|nhiệt độ|dự báo|mấy giờ|ngày tới|sắp tới|hôm nay|ngày mai|tuần tới/.test(text);
    if (!factualTiming) return true;
  }

  return false;
}

class AIService {
  // Cache toàn bộ danh sách destinations (dùng khi không detect được vùng)
  destinationsCache = null;
  cacheTime = null;
  CACHE_DURATION = 5 * 60 * 1000; // 5 phút

  // Cache specialties
  specialtiesCache = null;
  specialtiesCacheTime = null;

  // Cache danh sách tên địa danh (cho frontend)
  namesCache = null;
  namesCacheTime = null;

  // Cache danh sách tên tỉnh/thành (cho clarification form bước 2)
  provinceNamesCache = null;
  provinceNamesCacheTime = null;

  // Cache lite docs (đủ data render card + matching) cho trích "điểm đến được nhắc đến"
  destLiteCache = null;
  destLiteCacheTime = null;

  // ── Lấy destinations đã lọc theo vùng/tỉnh ─────────────────────────────────
  // Trả về { iconic, supporting }: iconic = điểm tham quan biểu tượng (đã cluster theo địa lý); supporting = ăn/ở bổ sung
  async getFilteredDestinations(regionInfo = null) {
    try {
      const baseQuery = {};

      if (regionInfo?.province) {
        const escapedProvince = regionInfo.province.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        baseQuery['location.city'] = { $regex: escapedProvince, $options: 'i' };
      } else if (regionInfo?.region) {
        const provinces = REGION_KEYWORDS[regionInfo.region] || [];
        if (provinces.length > 0) {
          baseQuery['location.city'] = { $regex: provinces.slice(0, 10).join('|'), $options: 'i' };
        }
      }

      const ATTRACTION_CATS = ['attraction', 'historical', 'landmark', 'temple', 'beach', 'mountain', 'culture', 'amusement', 'countryside'];
      const SUPPORT_CATS = ['restaurant', 'cafe', 'hotel'];

      // Bước 1: Lấy iconic/attraction trước (ưu tiên isIconic + iconicRank, rồi rating)
      const attractionLimit = regionInfo ? 18 : 12;
      const attractions = await Destination.find({
        ...baseQuery,
        category: { $in: ATTRACTION_CATS }
      })
        .select('name location category priceRange rating isIconic iconicRank')
        .sort({ isIconic: -1, iconicRank: 1, rating: -1 })
        .limit(attractionLimit);

      // Bước 2: Lấy thêm vài địa điểm ăn/ở để bổ sung (không phải điểm tham quan chính)
      const supportLimit = regionInfo ? 8 : 5;
      const supporting = await Destination.find({
        ...baseQuery,
        category: { $in: SUPPORT_CATS }
      })
        .select('name location category priceRange rating')
        .sort({ rating: -1 })
        .limit(supportLimit);

      // Fallback: nếu không có gì cho vùng này, dùng top-rated toàn quốc
      if (attractions.length === 0 && supporting.length === 0 && regionInfo) {
        return this.getFilteredDestinations(null);
      }

      const categoryMap = {
        beach: 'Biển', mountain: 'Núi', city: 'Thành phố', countryside: 'Nông thôn',
        historical: 'Di tích', attraction: 'Tham quan', landmark: 'Biểu tượng',
        temple: 'Đền/Chùa', culture: 'Văn hóa', amusement: 'Giải trí',
        restaurant: 'Nhà hàng', cafe: 'Cafe', hotel: 'Khách sạn'
      };
      const priceMap = { budget: 'Tiết kiệm', 'mid-range': 'Trung bình', luxury: 'Cao cấp' };

      const formatLine = (d, opts = {}) => {
        const star = opts.iconic ? '⭐ICONIC' : `⭐${d.rating}`;
        return `- ${d.name} (${d.location?.city || ''}) [${categoryMap[d.category] || d.category}, ${priceMap[d.priceRange] || d.priceRange || '-'}, ${star}]`;
      };

      // ── Cluster attractions theo địa lý (Haversine, bán kính 15km) ────────
      const clusters = this.clusterByGeography(attractions, 15);
      const iconicBlock = clusters
        .map((cluster, idx) => {
          const header = `▸ CỤM ${idx + 1} (gần nhau ~${cluster.spread}km - NÊN gom vào CÙNG 1 NGÀY):`;
          const lines = cluster.points.map(d => formatLine(d, { iconic: d.isIconic })).join('\n');
          return `${header}\n${lines}`;
        })
        .join('\n\n');

      const supportingBlock = supporting.map(d => formatLine(d)).join('\n');

      return { iconic: iconicBlock, supporting: supportingBlock, clusterCount: clusters.length };

    } catch (error) {
      console.error('Error getting filtered destinations:', error);
      return { iconic: '', supporting: '', clusterCount: 0 };
    }
  }

  // ── Haversine distance (km) giữa 2 điểm ──────────────────────────────────
  haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // ── Greedy clustering theo proximity ─────────────────────────────────────
  // Sort theo iconicRank, mỗi điểm chưa có cụm → seed cụm mới + gom các điểm trong radiusKm
  clusterByGeography(points, radiusKm = 15) {
    const valid = points.filter(p => p.location?.coordinates?.lat && p.location?.coordinates?.lng);
    const noCoord = points.filter(p => !(p.location?.coordinates?.lat && p.location?.coordinates?.lng));
    const used = new Set();
    const clusters = [];

    for (let i = 0; i < valid.length; i++) {
      if (used.has(i)) continue;
      used.add(i);
      const seed = valid[i];
      const members = [seed];
      let maxDist = 0;

      for (let j = i + 1; j < valid.length; j++) {
        if (used.has(j)) continue;
        const other = valid[j];
        const dist = this.haversineKm(
          seed.location.coordinates.lat, seed.location.coordinates.lng,
          other.location.coordinates.lat, other.location.coordinates.lng
        );
        if (dist <= radiusKm) {
          used.add(j);
          members.push(other);
          if (dist > maxDist) maxDist = dist;
        }
      }

      clusters.push({ points: members, spread: Math.round(maxDist) });
    }

    // Các điểm không có toạ độ → 1 cụm "chưa rõ vị trí" cuối
    if (noCoord.length > 0) {
      clusters.push({ points: noCoord, spread: 0, unknownLocation: true });
    }

    return clusters;
  }

  // Helper loại bỏ dấu tiếng Việt
  removeVietnameseTones(str) {
    if (!str) return '';
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  }

  // Rút "cụm địa điểm" trong câu bằng cách bỏ các từ đệm (tôi/muốn/đi/du lịch...).
  // Vd: "tôi muốn đi suối tiên" → "suối tiên"; "tôi muốn đi du lịch" → "".
  extractPlaceCandidate(text) {
    if (!text) return '';
    let t = text.toLowerCase();
    const fillerPhrases = [
      'khu du lịch sinh thái', 'khu du lịch', 'đi du lịch', 'du lịch', 'tôi muốn', 'muốn đi',
      'đi chơi', 'tham quan', 'khám phá', 'chuyến đi', 'một chuyến', 'lên kế hoạch', 'kế hoạch',
      'gợi ý', 'đề xuất', 'lịch trình', 'cho tôi', 'giúp tôi', 'giúp mình',
    ];
    for (const p of fillerPhrases) t = t.split(p).join(' ');
    const fillerWords = new Set([
      'tôi', 'mình', 'muốn', 'đi', 'đến', 'tới', 'về', 'chơi', 'ghé', 'thăm', 'chuyến', 'cho',
      'giúp', 'nên', 'vào', 'ở', 'tại', 'một', 'các', 'và', 'với', 'nha', 'ạ', 'là', 'đâu', 'đó',
      'chỗ', 'nơi', 'gì', 'nào', 'này', 'kia', 'hãy', 'cần', 'xem', 'ăn',
      // Từ chào hỏi / xã giao — KHÔNG phải địa danh. Nếu không loại, lời chào "xin chào"
      // bị khớp nhầm với tên địa điểm (vd "Nhà Hàng Xin Chào Phú Quốc" → ra Kiên Giang).
      'xin', 'chào', 'hello', 'hi', 'hey', 'alo', 'bạn', 'ơi', 'cảm', 'ơn', 'ok', 'oke',
    ]);
    const tokens = t.split(/\s+/).filter(w => w && !fillerWords.has(w));
    return tokens.join(' ').trim();
  }

  // Cụm chỉ là từ CHUNG CHUNG (biển/núi/...) → không coi là tên địa điểm cụ thể
  isGenericPlaceWord(coreNoTones) {
    const GENERIC = new Set([
      'bien', 'nui', 'dao', 'thac', 'ho', 'chua', 'rung', 'song', 'suoi', 'hang', 'dong',
      'vinh', 'thanh pho', 'que', 'nong thon', 'mien tay', 'tam bien', 'nghi duong',
    ]);
    return GENERIC.has(coreNoTones);
  }

  // ── Nhận diện vùng miền từ câu query ──────────────────────────────────────
  async detectRegionFromQuery(query) {
    if (!query) return null;
    const lowerQuery = query.toLowerCase();
    const noTonesQuery = this.removeVietnameseTones(query);
    
    // Tìm tỉnh cụ thể trước
    const allProvinces = Object.values(REGION_KEYWORDS).flat();
    let matchedProvince = allProvinces.find(p => lowerQuery.includes(p) || noTonesQuery.includes(this.removeVietnameseTones(p)));
    
    const destNames = await this.getDestinationNames();
    const provinceOfCity = (city) => allProvinces.find(p => city.toLowerCase().includes(p.toLowerCase()) || p.toLowerCase().includes(city.toLowerCase()));
    const regionOf = (prov) => {
      for (const [region, provinces] of Object.entries(REGION_KEYWORDS)) {
        if (provinces.includes(prov)) return region;
      }
      return null;
    };

    // 1) Có tỉnh cụ thể (province keyword) → return luôn
    if (matchedProvince) {
      const region = regionOf(matchedProvince);
      if (region) return { region, province: matchedProvince };
    }

    // 2) Vùng miền chung — XÉT TRƯỚC khi khớp tên địa danh (để "miền nam" ra VÙNG)
    if (lowerQuery.includes('miền bắc') || lowerQuery.includes('bắc bộ')) return { region: 'Miền Bắc', province: null };
    if (lowerQuery.includes('miền trung') || lowerQuery.includes('trung bộ')) return { region: 'Miền Trung', province: null };
    if (lowerQuery.includes('miền nam') || lowerQuery.includes('nam bộ') || lowerQuery.includes('miền tây') || lowerQuery.includes('đồng bằng sông cửu long')) return { region: 'Miền Nam', province: null };
    if (lowerQuery.includes('tây nguyên')) return { region: 'Tây Nguyên', province: null };

    // 3) Khớp tên địa danh trong DB — ĐẦY ĐỦ (tên nằm trong câu) HOẶC MỘT PHẦN (tên chứa cụm
    //    địa điểm, vd "suối tiên" → "Khu Du Lịch Suối Tiên"). CHỈ nhận khi KHÔNG mơ hồ: mọi địa
    //    danh khớp thuộc CÙNG 1 tỉnh. Nếu nhiều tỉnh (vd Suối Tiên ở Khánh Hòa/HCM/Kiên Giang)
    //    → null để web search liệt kê các lựa chọn cho người dùng.
    const coreNoTones = this.removeVietnameseTones(this.extractPlaceCandidate(query));
    const useCore = coreNoTones.length >= 4 && !this.isGenericPlaceWord(coreNoTones);
    const matches = destNames.filter(d => {
      if (!d.name || !d.city) return false;
      const dn = this.removeVietnameseTones(d.name);
      if (dn.length < 4) return false;
      return noTonesQuery.includes(dn) || (useCore && dn.includes(coreNoTones));
    });
    if (matches.length) {
      const provinces = new Set(matches.map(d => provinceOfCity(d.city)).filter(Boolean));
      if (provinces.size === 1) {
        const prov = [...provinces][0];
        const region = regionOf(prov);
        if (region) return { region, province: prov };
      }
    }

    return null; // Không xác định được vùng (hoặc địa danh mơ hồ) → để web search xử lý
  }

  // ── Clarification form: phát hiện yêu cầu mơ hồ & dựng form ────────────────
  // Có ý định du lịch trong câu hỏi không? (broad — bộ lọc thật là "thiếu địa điểm")
  hasTravelIntent(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    const intentKeywords = [
      'đi du lịch', 'du lịch', 'đi chơi', 'lên lịch', 'lịch trình', 'kế hoạch đi',
      'muốn đi', 'gợi ý điểm đến', 'nên đi đâu', 'đi đâu', 'trip', 'chuyến đi',
    ];
    return intentKeywords.some(k => t.includes(k));
  }

  // Nhận diện LOẠI HÌNH chuyến đi từ câu (biển/trăng mật/dã ngoại/...). Trả về object
  // trong TRIP_TYPES (type, intro, interests, defaults) hoặc null. Khớp theo RANH GIỚI TỪ
  // (containsWord) trên chuỗi đã bỏ dấu để 'bien' không dính nhầm trong "bienhoa"...
  detectTripType(text) {
    if (!text) return null;
    const noTones = this.removeVietnameseTones(text);
    for (const t of TRIP_TYPES) {
      if (t.keywords.some(kw => this.containsWord(noTones, kw))) return t;
    }
    return null;
  }

  // User đã nhắc tới số ngày chưa?
  extractDaysFromText(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    return /(\d+)\s*(ngày|ngay|đêm|dem|tuần|tuan)/i.test(t) || t.includes('cuối tuần');
  }

  // User đã nhắc tới ngân sách chưa?
  extractBudgetFromText(text) {
    if (!text) return false;
    return /(triệu|trieu|nghìn|nghin|ngàn|ngan|\btr\b|vnđ|vnd|ngân sách|ngan sach|tiết kiệm|tiet kiem|cao cấp|cao cap|\d{6,})/i.test(text);
  }

  // User đã nhắc tới số người đi chưa?
  extractPeopleFromText(text) {
    if (!text) return false;
    return /(\d+)\s*(người|nguoi|khách|khach)|gia đình|gia dinh|nhóm|nhom|cặp đôi|cap doi|một mình|mot minh|\bsolo\b|vợ chồng|vo chong|bạn bè|ban be/i.test(text);
  }

  // Lấy danh sách tên tỉnh/thành (từ ProvinceSpecialty), có cache
  async getAllProvinceNames() {
    if (this.provinceNamesCache && this.provinceNamesCacheTime && (Date.now() - this.provinceNamesCacheTime < this.CACHE_DURATION)) {
      return this.provinceNamesCache;
    }
    try {
      const names = await ProvinceSpecialty.distinct('province');
      this.provinceNamesCache = names.filter(Boolean);
      this.provinceNamesCacheTime = Date.now();
      return this.provinceNamesCache;
    } catch (e) {
      console.error('Error getting province names:', e);
      return [];
    }
  }

  // Phát hiện tỉnh/thành cụ thể trong text (bao phủ cả tỉnh không có trong REGION_KEYWORDS).
  // Đây là chốt chặn chống vòng lặp bước 2: tỉnh user vừa chọn LUÔN được nhận diện.
  async detectProvinceFromText(text) {
    if (!text) return null;
    const noTones = this.removeVietnameseTones(text);
    const provinces = await this.getAllProvinceNames();
    // Ưu tiên tên dài trước (vd "Bà Rịa - Vũng Tàu" trước "Vũng Tàu")
    const sorted = [...provinces].sort((a, b) => b.length - a.length);
    for (const p of sorted) {
      if (noTones.includes(this.removeVietnameseTones(p))) return p;
    }
    return null;
  }

  // Liệt kê các tỉnh trong 1 vùng CÓ điểm đến, sắp theo độ phong phú (nhiều điểm trước).
  async getProvincesInRegion(region) {
    try {
      const provinces = await ProvinceSpecialty.find({ region }).distinct('province');
      if (!provinces.length) return [];
      // Đếm số điểm đến mỗi tỉnh (tên tỉnh trùng với location.city)
      const counts = await Destination.aggregate([
        { $match: { 'location.city': { $in: provinces } } },
        { $group: { _id: '$location.city', count: { $sum: 1 } } },
      ]);
      const countMap = Object.fromEntries(counts.map(c => [c._id, c.count]));
      return provinces
        .filter(p => (countMap[p] || 0) > 0)
        .sort((a, b) => (countMap[b] || 0) - (countMap[a] || 0))
        .slice(0, 12);
    } catch (e) {
      console.error('Error getting provinces in region:', e);
      return [];
    }
  }

  // Dựng block ```json_form``` làm rõ yêu cầu. Trả về string (intro + fenced block) hoặc null.
  //  - Chưa có địa điểm      → BƯỚC 1: hỏi vùng + ngày/ngân sách/người/sở thích.
  //  - Có vùng, chưa có tỉnh → BƯỚC 2: liệt kê các tỉnh trong vùng để chọn cụ thể.
  //  - Đã có tỉnh cụ thể     → null (đủ thông tin → tạo lịch trình).
  async buildClarificationBlock(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // 1. Xét ý định trên tin nhắn user cuối. LOẠI HÌNH chuyến đi ("đi biển", "tuần
    //    trăng mật", "dã ngoại"...) cũng tính là có ý định — kể cả khi hasTravelIntent
    //    không bắt được (vd "đi dã ngoại", "đi phượt").
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return null;
    const tripType = this.detectTripType(lastUserMsg.content);
    if (!this.hasTravelIntent(lastUserMsg.content) && !tripType) return null;

    // 2. Xác định địa điểm tốt nhất trong ~4 tin user gần nhất (đa lượt)
    const recentUserMsgs = messages.filter(m => m.role === 'user').slice(-4);
    let knownRegion = null;
    for (const m of recentUserMsgs) {
      // Có tỉnh cụ thể (kể cả tỉnh ngoài REGION_KEYWORDS) → đủ thông tin → không hỏi nữa
      if (await this.detectProvinceFromText(m.content)) return null;
      const r = await this.detectRegionFromQuery(m.content);
      if (r?.province) return null;          // detectRegionFromQuery bắt được tỉnh
      if (r?.region) knownRegion = r.region;  // chỉ mới biết tới vùng
    }

    // 3. BƯỚC 2 — đã có vùng nhưng chưa có tỉnh → hỏi chọn tỉnh trong vùng
    if (knownRegion) {
      const provinces = await this.getProvincesInRegion(knownRegion);
      if (!provinces.length) return null; // không liệt kê được → để model tự xử lý
      const intro = `${knownRegion} có nhiều điểm đến hấp dẫn! Bạn muốn đi cụ thể tỉnh/thành nào để mình lên lịch trình chi tiết nhé 👇`;
      const block = JSON.stringify({
        type: 'clarification',
        step: 'province',
        title: `Chọn tỉnh/thành ở ${knownRegion}`,
        fields: [{
          key: 'location',
          label: `Bạn muốn đi tỉnh/thành nào ở ${knownRegion}?`,
          type: 'select',
          required: true,
          allowCustom: true,
          placeholder: 'Hoặc nhập tỉnh/thành khác...',
          options: provinces.map(p => ({ value: p, label: p })),
        }],
      });
      return `${intro}\n\n\`\`\`json_form\n${block}\n\`\`\``;
    }

    // 3b. Nếu user ĐÃ nêu một địa điểm cụ thể (dù chưa khớp DB/region) → KHÔNG hỏi form
    //     chung chung; để buildSystemPrompt tự web-search trả lời (vd "tôi muốn đi suối tiên",
    //     "đi đảo Robinson"...). NGOẠI LỆ: nếu cụm chỉ là LOẠI HÌNH chuyến đi (tripType) thì
    //     KHÔNG coi là địa danh (vd "tuần trăng mật", "leo núi") → vẫn hiện form làm rõ.
    const candidate = this.removeVietnameseTones(this.extractPlaceCandidate(lastUserMsg.content));
    if (candidate.length >= 3 && !this.isGenericPlaceWord(candidate) && !tripType) {
      return null;
    }

    // 4. BƯỚC 1 — chưa có địa điểm gì → hỏi vùng + các field còn thiếu
    const daysMentioned = this.extractDaysFromText(lastUserMsg.content);
    const budgetMentioned = this.extractBudgetFromText(lastUserMsg.content);
    const peopleMentioned = this.extractPeopleFromText(lastUserMsg.content);

    const fields = [CLARIFY_FIELDS.location];
    if (!daysMentioned) fields.push(CLARIFY_FIELDS.days);
    if (!budgetMentioned) fields.push(CLARIFY_FIELDS.budget);
    if (!peopleMentioned) fields.push(CLARIFY_FIELDS.people);
    fields.push(CLARIFY_FIELDS.interests);

    // Cá nhân hóa theo loại hình nếu nhận diện được: lời mở đầu riêng + tích sẵn sở thích
    // + mặc định (vd trăng mật → cặp đôi). defaults CHỈ giữ key ứng với field ĐANG hiển thị —
    // vì frontend compose() đọc theo answers, default cho field bị ẩn sẽ rò vào câu gửi đi.
    const fieldKeys = new Set(fields.map(f => f.key));
    const defaults = {};
    if (tripType) {
      const merged = { ...(tripType.defaults || {}), interests: tripType.interests };
      for (const [k, v] of Object.entries(merged)) {
        if (fieldKeys.has(k)) defaults[k] = v;
      }
    }

    const intro = tripType
      ? tripType.intro
      : 'Bạn muốn đi du lịch nhưng mình chưa rõ điểm đến. Bạn chọn giúp mình vài thông tin bên dưới để mình gợi ý lịch trình chính xác nhé! 👇';
    const block = JSON.stringify({
      type: 'clarification',
      step: 'overview',
      tripType: tripType?.type || null,
      title: 'Mình cần thêm vài thông tin để gợi ý chính xác hơn nhé!',
      fields,
      ...(Object.keys(defaults).length ? { defaults } : {}),
    });
    return `${intro}\n\n\`\`\`json_form\n${block}\n\`\`\``;
  }

  // ── Lấy specialties đã lọc theo tỉnh/vùng hoặc tên món ──────────────────────
  async getFilteredSpecialties(regionInfo = null, userQuery = '') {
    try {
      let query = {};
      
      if (regionInfo?.province) {
        const escapedProvince = regionInfo.province.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        query.province = { $regex: escapedProvince, $options: 'i' };
      } else if (regionInfo?.region) {
        query.region = regionInfo.region;
      }

      let specialties = await ProvinceSpecialty.find(query)
        .select('province region localDishes souvenirs')
        .sort({ stt: 1 })
        .limit(regionInfo ? 10 : 5);

      // Nếu không tìm được theo vùng VÀ user hỏi về một món cụ thể,
      // tìm thêm bằng text search trên tên món ăn
      if (!regionInfo && userQuery) {
        const lowerQuery = userQuery.toLowerCase();
        const byDishName = await ProvinceSpecialty.find({
          $or: [
            { localDishesText: { $regex: lowerQuery, $options: 'i' } },
            { souvenirsText: { $regex: lowerQuery, $options: 'i' } },
            { 'localDishes.name': { $regex: lowerQuery, $options: 'i' } },
            { 'souvenirs.name': { $regex: lowerQuery, $options: 'i' } },
          ]
        }).select('province region localDishes souvenirs').limit(5);
        
        // Gộp vào kết quả, tránh trùng tỉnh
        const existingProvinces = new Set(specialties.map(s => s.province));
        for (const s of byDishName) {
          if (!existingProvinces.has(s.province)) {
            specialties.push(s);
            existingProvinces.add(s.province);
          }
        }
      }

      if (specialties.length === 0) return '';

      return specialties.map(s => {
        const dishes = s.localDishes?.slice(0, 4).map(d => `${d.name}${d.estimatedPrice ? ` (Giá: ${d.estimatedPrice})` : ''}${d.imageUrl ? ` (Ảnh: ${d.imageUrl})` : ''}`).join(', ') || '';
        const souvenirs = s.souvenirs?.slice(0, 3).map(d => `${d.name}${d.estimatedPrice ? ` (Giá: ${d.estimatedPrice})` : ''}${d.imageUrl ? ` (Ảnh: ${d.imageUrl})` : ''}`).join(', ') || '';
        return `- ${s.province} (${s.region}): Món ăn [${dishes}] | Đặc sản [${souvenirs}]`;
      }).join('\n');

    } catch (error) {
      console.error('Error getting filtered specialties:', error);
      return '';
    }
  }

  // ── Lấy danh sách tên địa danh (cho frontend matching) ───────────────────
  async getDestinationNames() {
    if (this.namesCache && this.namesCacheTime && (Date.now() - this.namesCacheTime < this.CACHE_DURATION)) {
      return this.namesCache;
    }
    try {
      const destinations = await Destination.find({}).select('name location.city').lean();
      const names = destinations.map(d => ({ name: d.name, city: d.location?.city || '' }));
      this.namesCache = names;
      this.namesCacheTime = Date.now();
      return names;
    } catch (error) {
      console.error('Error getting destination names:', error);
      return [];
    }
  }

  // ── Lite docs (đủ data render card) + tên/thành phố đã chuẩn hoá (cache) ─────
  async getDestinationsLite() {
    if (this.destLiteCache && this.destLiteCacheTime && (Date.now() - this.destLiteCacheTime < this.CACHE_DURATION)) {
      return this.destLiteCache;
    }
    try {
      const docs = await Destination.find({})
        .select('name location images category rating priceRange description')
        .lean();
      for (const d of docs) {
        d._nn = this.removeVietnameseTones(d.name || '');          // tên không dấu, thường
        d._nc = this.removeVietnameseTones(d.location?.city || ''); // city không dấu, thường
        d._core = this.coreDestName(d._nn);                          // lõi tên (bỏ tiền tố loại hình)
      }
      this.destLiteCache = docs;
      this.destLiteCacheTime = Date.now();
      return docs;
    } catch (e) {
      console.error('Error getting destinations lite:', e);
      return [];
    }
  }

  // Bỏ tiền tố loại hình ("Khu Du Lịch", "Công Viên"...) để lấy lõi tên địa danh
  coreDestName(noTonesName) {
    const prefixes = [
      'khu du lich sinh thai', 'khu du lich van hoa', 'khu du lich cong dong', 'khu du lich',
      'khu di tich lich su', 'khu di tich', 'khu tuong niem', 'khu bao ton',
      'cong vien', 'vuon quoc gia', 'bao tang', 'nha tho', 'thanh duong', 'khu nghi duong',
    ];
    for (const p of prefixes) {
      if (noTonesName.startsWith(p + ' ')) return noTonesName.slice(p.length).trim();
    }
    return noTonesName;
  }

  // Khớp `needle` trong `haystack` theo RANH GIỚI TỪ (chuỗi đã bỏ dấu, thường hoá).
  // Khác .includes(): "thanh" KHÔNG khớp trong "thanh pho" (vì "pho" dính liền sau),
  // nhưng "thanh pho" khớp đúng. Ranh giới = đầu/cuối chuỗi hoặc ký tự không phải [a-z0-9].
  containsWord(haystack, needle) {
    if (!haystack || !needle) return false;
    let from = 0;
    while (true) {
      const idx = haystack.indexOf(needle, from);
      if (idx === -1) return false;
      const before = idx === 0 ? '' : haystack[idx - 1];
      const after = idx + needle.length >= haystack.length ? '' : haystack[idx + needle.length];
      const boundaryBefore = !before || !/[a-z0-9]/.test(before);
      const boundaryAfter = !after || !/[a-z0-9]/.test(after);
      if (boundaryBefore && boundaryAfter) return true;
      from = idx + 1;
    }
  }

  // Tên 1 TỪ trùng từ thông dụng tiếng Việt → cực dễ false-positive (vd "Thành",
  // "Một", "Mộc", "Gió"). Chỉ nên trích khi có tỉnh ngữ cảnh khớp đúng.
  isAmbiguousShortName(noTonesName) {
    if (!noTonesName || noTonesName.includes(' ')) return false; // chỉ xét tên 1 từ
    const COMMON = new Set([
      'thanh', 'mot', 'moc', 'gio', 'sam', 'pi', 'temple', 'breathe', 'rua', 'co', 'mai',
      'nha', 'cho', 'bien', 'nui', 'pho', 'que', 'song', 'ho', 'rung', 'cau', 'cua', 'dao',
    ]);
    return COMMON.has(noTonesName);
  }

  // ── Trích "điểm đến được nhắc đến" trong 1 đoạn text (cho card AI chat) ──────
  // Khớp KHÔNG phân biệt hoa/dấu, cả tên đầy đủ lẫn lõi tên; lọc theo TỈNH NGỮ CẢNH
  // (có alias TP.HCM/Sài Gòn...) để KHÔNG hiện card sai tỉnh. Trả về dạng card frontend.
  async extractMentionedDestinations(text, limit = 10, question = '') {
    if (!text) return [];
    // Câu hỏi NGOÀI LỀ (kiến thức chung / hành chính, vd "Việt Nam có bao nhiêu tỉnh",
    // "Trà Vinh còn không") → AI chỉ liệt kê tên tỉnh/thành chứ không gợi ý điểm đến.
    // Bỏ qua trích card để tránh hiện "Điểm đến được nhắc đến" sai ngữ cảnh.
    if (question && this.isGeneralKnowledgeQuery(question)) return [];
    const docs = await this.getDestinationsLite();
    const noTonesText = this.removeVietnameseTones(text);

    // 1) Tỉnh ngữ cảnh: city xuất hiện trực tiếp trong text (khớp theo TỪ, không substring)
    const ctxCities = new Set();
    for (const d of docs) {
      if (d._nc && d._nc.length >= 4 && this.containsWord(noTonesText, d._nc)) ctxCities.add(d.location.city);
    }
    // 1b) Alias tỉnh (text viết tắt khác với tên DB)
    const aliasGroups = [
      { pats: ['hcm', 'tphcm', 'tp.hcm', 'sai gon'], frag: 'ho chi minh' },
      { pats: ['vung tau'], frag: 'vung tau' },
    ];
    const hitFrags = aliasGroups.filter(g => g.pats.some(p => noTonesText.includes(p))).map(g => g.frag);
    if (hitFrags.length) {
      for (const d of docs) {
        if (d._nc && hitFrags.some(f => d._nc.includes(f))) ctxCities.add(d.location.city);
      }
    }

    // Tập tên tỉnh/thành (chuẩn hoá) — để loại "lõi tên" trùng tên tỉnh (vd "da nang"),
    // tránh khớp/mở rộng tràn lan ra mọi địa danh trong tỉnh.
    const cityNormSet = new Set(docs.map(d => d._nc).filter(Boolean));

    // 2) Khớp TRỰC TIẾP theo RANH GIỚI TỪ (không substring thô): tên đầy đủ trong text,
    //    HOẶC lõi tên (≥5 ký tự, KHÔNG phải tên tỉnh). Tên 1 TỪ trùng từ thông dụng tiếng
    //    Việt (Thành/Một/Mộc/Gió...) bị loại trừ trừ khi có tỉnh ngữ cảnh khớp đúng — vì
    //    chúng cực dễ false-positive (vd "thành phố" → khớp nhầm địa điểm tên "Thành").
    const directMatches = docs.filter(d => {
      if (!d._nn || d._nn.length < 4) return false;
      if (this.isAmbiguousShortName(d._nn) && !ctxCities.has(d.location?.city)) return false;
      if (this.containsWord(noTonesText, d._nn)) return true;
      return d._core.length >= 5 && !cityNormSet.has(d._core) && this.containsWord(noTonesText, d._core);
    });

    // 2b) Cụm địa danh "chắc chắn có trong text" (bỏ cụm trùng tên tỉnh) → để mở rộng sang
    //     địa danh CÙNG TÊN trong tỉnh ngữ cảnh mà tên DB dài hơn (vd "Suối Tiên" + HCM →
    //     "Công viên văn hóa Suối Tiên").
    const phrases = [...new Set(directMatches.map(d => d._core)
      .filter(p => p.length >= 5 && !cityNormSet.has(p)))];

    // 3) Chọn kết quả:
    //  - Có tỉnh ngữ cảnh → CHỈ giữ địa danh đúng tỉnh (khớp trực tiếp + mở rộng theo cụm).
    //  - Không có ngữ cảnh → giữ các khớp trực tiếp (best-effort, có thể gồm nhiều tỉnh).
    let result;
    if (ctxCities.size > 0) {
      // Mở rộng theo cụm — CHỈ với cụm ĐỦ ĐẶC TRƯNG (khớp ≤3 địa danh trong tỉnh ngữ cảnh).
      // Cụm chung chung như "bãi biển" khớp quá nhiều → bỏ qua để không "nổ" card.
      const expanded = [];
      for (const p of phrases) {
        const hits = docs.filter(d => d._nn && ctxCities.has(d.location?.city) && this.containsWord(d._nn, p));
        if (hits.length <= 3) expanded.push(...hits);
      }
      result = [...directMatches, ...expanded].filter(d => ctxCities.has(d.location?.city));
    } else {
      result = directMatches;
    }

    // 4) Ưu tiên rating cao, khử trùng theo _id, giới hạn
    const ranked = [...result].sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const seen = new Set();
    const out = [];
    for (const d of ranked) {
      const id = String(d._id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        _id: id, name: d.name, images: d.images || [], location: d.location,
        category: d.category, rating: d.rating, priceRange: d.priceRange, description: d.description,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ── Lấy context người dùng ─────────────────────────────────────────────────
  async getUserContext(userId) {
    try {
      const user = await User.findById(userId)
        .populate('savedDestinations', 'name location category priceRange');
      
      const itineraries = await Itinerary.find({ user: userId })
        .populate('destinations.destination', 'name location category')
        .sort({ createdAt: -1 })
        .limit(3);

      let context = '';

      if (user?.preferences) {
        const { travelStyle, budget, interests } = user.preferences;
        if (travelStyle?.length) context += `\n- Phong cách du lịch yêu thích: ${travelStyle.join(', ')}`;
        if (budget) context += `\n- Ngân sách: ${budget === 'low' ? 'Tiết kiệm' : budget === 'medium' ? 'Trung bình' : 'Cao cấp'}`;
        if (interests?.length) context += `\n- Sở thích: ${interests.join(', ')}`;
      }

      if (user?.savedDestinations?.length) {
        const savedNames = user.savedDestinations.map(d =>
          `${d.name} (${d.location?.city || ''}, ${d.category})`
        ).join(', ');
        context += `\n- Địa điểm đã lưu: ${savedNames}`;
      }

      if (itineraries.length) {
        const itinInfo = itineraries.map(it => {
          const dests = it.destinations.map(d => d.destination?.name).filter(Boolean).join(', ');
          return `"${it.title}" (${dests})`;
        }).join('; ');
        context += `\n- Lịch trình đã tạo: ${itinInfo}`;
      }

      return context;
    } catch (error) {
      console.error('Error getting user context:', error);
      return '';
    }
  }

  // ── Lấy public itineraries phù hợp với query của user ─────────────────────
  async getPublicItineraries(queryText) {
    try {
      // Map từ khoá → category destination
      const categoryMap = {
        biển: 'beach', núi: 'mountain', thành: 'city', lịch: 'historical',
        văn: 'culture', chùa: 'temple', vui: 'amusement', đảo: 'beach',
      };
      let destFilter = {};
      const lowerQ = queryText.toLowerCase();
      for (const [kw, cat] of Object.entries(categoryMap)) {
        if (lowerQ.includes(kw)) { destFilter.category = cat; break; }
      }

      // Lấy destination IDs phù hợp nếu có filter
      let destIds = null;
      if (destFilter.category) {
        const matchDests = await Destination.find(destFilter).select('_id').limit(50);
        destIds = matchDests.map(d => d._id);
      }

      const filter = { isPublic: true };
      if (destIds?.length) filter['destinations.destination'] = { $in: destIds };

      const itineraries = await Itinerary.find(filter)
        .populate('destinations.destination', 'name location category')
        .populate('user', 'name')
        .sort({ createdAt: -1 })
        .limit(5);

      if (!itineraries.length) return null;

      return itineraries.map(it => {
        const dests = it.destinations.map(d => d.destination?.name).filter(Boolean).join(', ');
        const days = it.startDate && it.endDate
          ? Math.max(1, Math.ceil((new Date(it.endDate) - new Date(it.startDate)) / 86400000))
          : '?';
        const budget = it.budget?.estimated
          ? ` | Ngân sách: ${it.budget.estimated.toLocaleString('vi-VN')}đ`
          : '';
        return `• "${it.title}" (${days} ngày) — ${dests}${budget}`;
      }).join('\n');
    } catch (err) {
      console.error('Error getting public itineraries:', err);
      return null;
    }
  }

  // Câu hỏi tra cứu SỰ KIỆN/THÔNG TIN cụ thể (giá vé, giờ mở cửa, khoảng cách, "là gì"...)
  // → nên tra web để trả lời chính xác, kể cả khi địa điểm có trong DB.
  isFactualQuery(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    const noTones = this.removeVietnameseTones(text);
    const patterns = [
      'giá vé', 'gia ve', 'vé vào', 've vao', 'phí vào', 'phi vao', 'giá phòng', 'gia phong',
      'bao nhiêu tiền', 'bao nhieu tien', 'mấy giờ', 'may gio', 'mở cửa', 'mo cua', 'đóng cửa', 'dong cua',
      'giờ mở', 'gio mo', 'bao xa', 'khoảng cách', 'khoang cach', 'cách bao', 'cach bao',
      'thời tiết', 'thoi tiet', 'nhiệt độ', 'nhiet do', 'là gì', 'la gi', 'là ai', 'la ai', 'ai là', 'ai la',
      'khi nào', 'khi nao', 'năm nào', 'nam nao', 'lịch sử', 'lich su', 'sự kiện', 'su kien', 'tin tức', 'tin tuc',
      'số điện thoại', 'so dien thoai', 'địa chỉ', 'dia chi', 'website', 'hotline', 'dân số', 'dan so',
      'diện tích', 'dien tich', 'cao bao nhiêu', 'cao bao nhieu', 'rộng bao nhiêu', 'rong bao nhieu',
      // chi phí / miễn phí / thực tế
      'free', 'miễn phí', 'mien phi', 'mất phí', 'mat phi', 'tốn tiền', 'ton tien', 'có phí', 'co phi',
      'tính phí', 'tinh phi', 'có mất', 'co mat', 'mất tiền', 'mat tien', 'có tốn', 'co ton',
      'an toàn', 'an toan', 'có nên', 'co nen', 'đặt vé', 'dat ve', 'đặt phòng', 'dat phong',
      'gửi xe', 'gui xe', 'đỗ xe', 'do xe', 'di chuyển', 'di chuyen', 'phương tiện', 'phuong tien',
      'review', 'đánh giá', 'danh gia', 'mùa nào', 'mua nao', 'tháng nào', 'thang nao',
    ];
    return patterns.some(p => t.includes(p) || noTones.includes(p));
  }

  // Câu hỏi về MÓN ĂN / đặc sản (gồm cả hỏi thêm "còn món nào", "món khác")
  isFoodQuestion(text) {
    if (!text) return false;
    const noTones = this.removeVietnameseTones(text);
    return /an gi|an cai gi|cai gi an|an thu gi|mon gi|mon nao|mon an|mon khac|con mon|them mon|mon ngon|dac san|an mon|an them|quan an|an o dau|am thuc|do an|an vat|an uong|nau gi|co mon/.test(noTones);
  }

  // Câu hỏi KIẾN THỨC CHUNG / hành chính / địa lý (KHÔNG phải hỏi đi chơi) → không hiện
  // card "điểm đến được nhắc đến". Vd: "Việt Nam có bao nhiêu tỉnh", "Trà Vinh còn không",
  // "Hồ Chí Minh là ai". Nếu câu hỏi có Ý ĐỊNH DU LỊCH rõ ràng (đi đâu, chơi gì, ăn gì,
  // lịch trình, gợi ý điểm đến...) thì BỎ QUA gate này để vẫn hiện card bình thường.
  isGeneralKnowledgeQuery(text) {
    if (!text) return false;
    const noTones = this.removeVietnameseTones(text);

    // 1) Ý định du lịch rõ ràng → luôn cho hiện card (ưu tiên cao nhất)
    const travelIntent = [
      'di dau', 'choi gi', 'choi o', 'co gi choi', 'co gi an', 'tham quan', 'dia diem',
      'diem den', 'du lich', 'lich trinh', 'an gi', 'mon gi', 'mon nao', 'dac san',
      'an o dau', 'quan an', 'am thuc', 'goi y', 'de xuat', 'nghi duong', 'khach san',
      'homestay', 'resort', 'check in', 'song ao', 'canh dep', 'view dep', 'bai bien',
      'bien dep', 'co bien', 'nen di', 'ghe tham', 'kham pha', 'phuot', 'vui choi',
      'giai tri', 'cho nao dep', 'noi nao dep',
    ];
    if (travelIntent.some(k => noTones.includes(k))) return false;

    // 2) Dấu hiệu kiến thức chung / hành chính / địa lý
    const generalKnowledge = [
      'bao nhieu tinh', 'bao nhieu thanh pho', 'bao nhieu don vi', 'bao nhieu huyen',
      'don vi hanh chinh', 'cap tinh', 'sap nhap', 'con khong', 'con ton tai', 'doi ten',
      'truc thuoc', 'thuoc tinh nao', 'thuoc mien nao', 'nam o dau', 'o mien nao',
      'giap voi', 'tiep giap', 'la gi', 'la ai', 'ai la', 'dan so', 'dien tich',
      'thu do', 'lich su', 'thanh lap', 'nam nao', 'the ky', 'ma vung', 'bien so',
      'quoc khanh', 'dan toc', 'ngon ngu', 'tien te', 'gdp', 'co tu khi nao', 'tu nam',
    ];
    return generalKnowledge.some(k => noTones.includes(k));
  }

  // ── Build system prompt thông minh ─────────────────────────────────────────
  async buildSystemPrompt(messages, userId = null) {
    let systemPrompt = SYSTEM_PROMPT;

    // Detect vùng/tỉnh từ tin nhắn cuối; nếu follow-up KHÔNG nêu địa điểm → kế thừa vùng từ
    // NGỮ CẢNH các tin user gần nhất (vd hỏi "nên ăn món gì" sau khi đã nói Vũng Tàu).
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    let regionInfo = lastUserMsg ? await this.detectRegionFromQuery(lastUserMsg.content) : null;
    if (!regionInfo && lastUserMsg) {
      const recentUsers = messages.filter(m => m.role === 'user').slice(-5).reverse();
      for (const m of recentUsers) {
        const r = await this.detectRegionFromQuery(m.content);
        if (r) { regionInfo = r; console.log(`[AI] Region kế thừa ngữ cảnh: ${r.region}${r.province ? ' / ' + r.province : ''}`); break; }
      }
    }
    
    if (regionInfo) {
      console.log(`[AI] Detected region: ${regionInfo.region}${regionInfo.province ? ` / ${regionInfo.province}` : ''}`);
    } else {
      console.log(`[AI] No region detected, using top-rated fallback`);
    }

    // Cập nhật hành chính 2025: nếu câu hỏi liên quan tỉnh/thành → cấp bảng đối chiếu cũ↔mới
    // để AI hiểu cả tên cũ lẫn mới (DB vẫn dùng tên cũ, không đổi dữ liệu).
    if (lastUserMsg) {
      const noTonesQ = this.removeVietnameseTones(lastUserMsg.content);
      const adminRelevant = !!regionInfo
        || MERGER_KEYWORDS.some(k => noTonesQ.includes(this.removeVietnameseTones(k)))
        || RESTRUCTURED_NAMES.some(n => noTonesQ.includes(this.removeVietnameseTones(n)));
      if (adminRelevant) {
        systemPrompt += `\n\n${MERGER_CONTEXT_BLOCK}`;
      }
    }

    // ── Phase 2: Song song TẤT CẢ query DB độc lập ─────────────────────────
    // Trước đây chạy tuần tự 5-6 await (mỗi cái 100-300ms) → cộng dồn 1-2s.
    // Giờ gom vào Promise.all để chỉ tốn thời gian của query CHẬM NHẤT.
    const needTours = detectTourSearchQuery(messages) && !!lastUserMsg;
    const tPhase2 = Date.now();

    const [
      { iconic, supporting, clusterCount },
      specialtiesList,
      userContext,
      routeInfo,
      publicTours,
    ] = await Promise.all([
      this.getFilteredDestinations(regionInfo),
      this.getFilteredSpecialties(regionInfo, lastUserMsg?.content || ''),
      userId ? this.getUserContext(userId).catch(() => '') : Promise.resolve(''),
      lastUserMsg ? routingService.processUserQuery(lastUserMsg.content).catch(() => null) : Promise.resolve(null),
      needTours ? this.getPublicItineraries(lastUserMsg.content).catch(() => null) : Promise.resolve(null),
    ]);

    console.log(`[AI-PERF] Phase 2 (parallel queries): ${Date.now() - tPhase2}ms`);

    const label = regionInfo?.province
      ? regionInfo.province
      : regionInfo?.region
      ? `vùng ${regionInfo.region}`
      : 'phổ biến nhất';

    if (iconic) {
      systemPrompt += `\n\n[ĐIỂM ĐẾN BIỂU TƯỢNG - ${label.toUpperCase()} - ĐÃ NHÓM THEO CỤM ĐỊA LÝ - ƯU TIÊN CAO]\n${iconic}`;
    }
    if (supporting) {
      systemPrompt += `\n\n[CHỖ Ở & ẨM THỰC - ${label.toUpperCase()} - Chỉ dùng để bổ sung sau khi đã gợi ý điểm tham quan biểu tượng]\n${supporting}`;
    }
    if (iconic || supporting) {
      systemPrompt += `\n\n[QUY TẮC GỢI Ý ĐIỂM ĐẾN]
- LUÔN ưu tiên các địa điểm có nhãn ⭐ICONIC trước khi gợi ý các địa điểm khác.
- KHÔNG BAO GIỜ đưa nhà hàng/quán cafe/khách sạn làm điểm tham quan chính; chỉ dùng chúng để bổ sung sau khi đã đề xuất ít nhất 2-3 điểm tham quan biểu tượng.
- Nếu user hỏi "nên đi đâu ở [tỉnh]" → liệt kê các ICONIC trước, kèm 1 dòng mô tả ngắn cho mỗi điểm.

[QUY TẮC PHÂN BỔ THEO NGÀY - QUAN TRỌNG khi tạo lịch trình nhiều ngày]
- Các điểm trong CÙNG MỘT CỤM (vd "CỤM 1") nằm gần nhau về địa lý → BẮT BUỘC gom vào CÙNG MỘT NGÀY để tiết kiệm thời gian di chuyển.
- KHÔNG ĐƯỢC tách 2 điểm trong cùng cụm ra 2 ngày khác nhau (vd KHÔNG được để Ao Bà Om ngày 1 và Chùa Âng ngày 2 nếu chúng cùng CỤM 1).
- Nếu 1 cụm có quá nhiều điểm cho 1 ngày, có thể chia thành "sáng/chiều" trong cùng ngày, hoặc chia ra 2 ngày liên tiếp.
- Số cụm hiện có: ${clusterCount || 0}. Nếu user yêu cầu N ngày mà chỉ có M cụm (M < N), hãy phân bổ mỗi cụm cho 1 ngày + thêm hoạt động bổ sung (ẩm thực, nghỉ ngơi) cho các ngày còn lại.
- Khi user yêu cầu N ngày mà M > N cụm, ưu tiên các CỤM đầu (CỤM 1, 2, ...) vì chúng chứa các điểm rank cao nhất.`;
    }

    if (specialtiesList) {
      systemPrompt += `\n\n[ĐẶC SẢN ĐỊA PHƯƠNG - Sử dụng khi hỏi về món ăn/đặc sản]\n${specialtiesList}\nLƯU Ý QUAN TRỌNG: Khi gợi ý đặc sản, BẮT BUỘC chèn ảnh nếu có (cú pháp: ![Tên món](URL_Ảnh)). KHI BÁO GIÁ, BẮT BUỘC DÙNG ĐÚNG GIÁ TRONG DANH SÁCH.\nLƯU Ý ĐỊNH DẠNG BẢNG: TUYỆT ĐỐI không dùng ký tự \`||\`, chỉ dùng 1 dấu \`|\` để phân tách các cột trong bảng Markdown.`;
    }

    if (userContext) {
      systemPrompt += `\n\n[THÔNG TIN NGƯỜI DÙNG - Cá nhân hóa gợi ý]${userContext}`;
    }

    if (routeInfo?.detected) {
      console.log(`[AI] Route detected: ${routeInfo.from} → ${routeInfo.to}`);
      systemPrompt += routeInfo.injectionText;
    }

    if (publicTours) {
      systemPrompt += `\n\n[TOUR / LỊCH TRÌNH CÔNG KHAI TRONG HỆ THỐNG]\n${publicTours}\n\n**HƯỚNG DẪN:** Giới thiệu các tour trên cho người dùng. Nếu người dùng muốn tour khác, đề nghị tạo lịch trình riêng.`;
    } else if (needTours) {
      systemPrompt += `\n\n[THÔNG TIN TOUR — CHƯA CÓ TOUR DỰNG SẴN]
Hệ thống chưa có tour công khai dựng sẵn phù hợp. KHÔNG bịa tour. Phản hồi theo đúng cấu trúc sau:
- Câu 1: Thông báo ngắn chưa có tour dựng sẵn, đề nghị tạo lịch trình riêng.
- Sau đó ghi đúng 5 câu hỏi RIÊNG BIỆT (đánh số 1-5), KHÔNG gộp lại:
  1. Bạn muốn đi biển ở khu vực nào (miền Bắc, miền Trung, miền Nam) hay có tỉnh/thành phố cụ thể muốn đến không?
  2. Thời gian du lịch dự kiến là bao lâu?
  3. Ngân sách dự kiến cho chuyến đi là bao nhiêu?
  4. Bạn thích hoạt động gì ở biển (tắm biển, lặn ngắm san hô, thưởng thức hải sản, tham quan các điểm đến biển nổi tiếng, v.v.)?
  5. Số người đi cùng và có yêu cầu đặc biệt nào không (ví dụ đi cùng trẻ nhỏ, người già, thích chỗ ở yên tĩnh hay sầm uất)?
TUYỆT ĐỐI không lặp lại câu trả lời ở lượt trước.`;
    }

    // Nếu user hỏi về lịch trình → thêm instruction JSON
    if (detectItineraryQuery(messages)) {
      systemPrompt += ITINERARY_JSON_INSTRUCTION;
    }

    // ── Web search fallback: câu hỏi NGOÀI dữ liệu hệ thống → tra Google, KHÔNG bịa ──
    // Kích hoạt khi: (a) hỏi sự kiện/giá/giờ... cụ thể, HOẶC (b) DB không có gì để trả lời.
    if (lastUserMsg) {
      const q = lastUserMsg.content;
      const nq = this.removeVietnameseTones(q);
      const isFactual = this.isFactualQuery(q);
      const isTourSearch = detectTourSearchQuery(messages);
      // User nêu một địa điểm cụ thể NHƯNG không resolve được vùng/tỉnh → tra web để liệt kê.
      const placeRaw = this.extractPlaceCandidate(q);
      const candidate = this.removeVietnameseTones(placeRaw);
      const placeUnresolved = !regionInfo && candidate.length >= 4 && !this.isGenericPlaceWord(candidate);
      // Hỏi món ăn: tra web khi DB KHÔNG có đặc sản, HOẶC user muốn THÊM (còn/khác/nữa) ngoài
      // danh sách DB (vd "còn món nào nữa không").
      const isFood = this.isFoodQuestion(q);
      const wantsMore = /\b(con|them|khac|nua|ngoai ra)\b/.test(nq);
      const foodNeedsWeb = isFood && (!specialtiesList || wantsMore);
      // Catch-all: câu hỏi YES/NO / chi tiết trong ngữ cảnh 1 tỉnh, KHÔNG phải hỏi điểm đến/
      // lịch trình/món ăn → DB không lưu loại chi tiết này (free, an toàn, đi lại...) → tra web.
      const isQuestion = /\?|không|hông|\bko\b|chưa|nhỉ|hả/.test(q) || /\bkhong\b|\bhong\b/.test(nq);
      const isDestOrItin = detectItineraryQuery(messages) || /co gi|gi choi|di dau|diem den|nen di|choi gi|tham quan|ngam canh/.test(nq);
      const detailFollowup = !!regionInfo && isQuestion && !isDestOrItin && !isFood;
      const shouldSearch = !isTourSearch && (isFactual || placeUnresolved || foodNeedsWeb || detailFollowup);

      if (shouldSearch) {
        // Tinh chỉnh truy vấn theo loại câu hỏi để lấy đúng thông tin thực tế.
        const loc = regionInfo?.province || regionInfo?.region || '';
        let searchQuery;
        if (foodNeedsWeb) {
          searchQuery = loc ? `đặc sản ${loc} ăn món gì ngon nổi tiếng` : lastUserMsg.content;
        } else if (placeUnresolved && !isFactual) {
          searchQuery = `${placeRaw} du lịch giá vé giờ mở cửa địa chỉ`;
        } else if (loc) {
          // Câu hỏi chi tiết trong ngữ cảnh 1 tỉnh → kèm tên tỉnh để Google ra đúng nơi
          // (vd "biển ở đây tắm free hông" → "biển ở đây tắm free hông vũng tàu").
          searchQuery = `${lastUserMsg.content} ${loc}`;
        } else {
          searchQuery = lastUserMsg.content;
        }
        console.log(`[AI] Web search triggered (factual=${isFactual}, placeUnresolved=${placeUnresolved}) for: "${searchQuery.slice(0, 70)}"`);
        let webResults = null;
        try {
          webResults = await searchService.webSearch(searchQuery);
        } catch (e) {
          console.warn('[AI] Web search error:', e.message);
        }
        if (webResults) {
          systemPrompt += `\n\n[KẾT QUẢ TÌM KIẾM WEB - dùng để trả lời CHÍNH XÁC câu hỏi nằm ngoài dữ liệu hệ thống]\n${webResults}\n\nHƯỚNG DẪN: Trả lời dựa trên các kết quả tìm kiếm web ở trên (thông tin thực tế từ Google), trích nguồn (link) khi phù hợp. Nếu kết quả vẫn chưa đủ chắc chắn, hãy nói rõ "Mình chưa tìm thấy thông tin chắc chắn về vấn đề này" — TUYỆT ĐỐI KHÔNG bịa.`;
        } else {
          systemPrompt += `\n\n[LƯU Ý] Câu hỏi này nằm ngoài dữ liệu hệ thống và tìm kiếm web không trả về kết quả. Nếu không chắc chắn, hãy nói rõ bạn chưa có thông tin chính xác và đề nghị người dùng kiểm tra nguồn chính thống — TUYỆT ĐỐI KHÔNG bịa.`;
        }
      }
    }

    return systemPrompt;
  }

  // ── Chat streaming ──────────────────────────────────────────────────────────
  async chat(messages, onChunk, userId = null) {
    const t0 = Date.now();
    const systemPrompt = await this.buildSystemPrompt(messages, userId);
    console.log(`[AI-PERF] buildSystemPrompt: ${Date.now() - t0}ms`);

    // Sliding window: chỉ gửi MAX_CHAT_WINDOW message cuối lên model.
    // buildSystemPrompt đã inject context quan trọng (vùng, điểm đến, sở thích...)
    const trimmed = messages.length > MAX_CHAT_WINDOW ? messages.slice(-MAX_CHAT_WINDOW) : messages;
    if (messages.length > MAX_CHAT_WINDOW) {
      console.log(`[AI-PERF] Trimmed ${messages.length} → ${trimmed.length} messages (window=${MAX_CHAT_WINDOW})`);
    }
    const allMessages = [{ role: 'system', content: systemPrompt }, ...trimmed];
    const params = { messages: allMessages, stream: true, max_tokens: MAX_TOKENS, temperature: 0.4, top_p: 0.9 };

    const preferredProvider = process.env.AI_PROVIDER || 'nvidia';
    let client, model, provider;

    if (preferredProvider === 'nvidia') {
      // Try step-3.7-flash first
      try {
        client = nvidiaClient; model = NVIDIA_MODEL_PRIMARY; provider = 'nvidia-step3.7';
        const stream = await client.chat.completions.create(withModel(params, model));
        console.log(`[AI-PERF] ${provider} (${model}) stream open: ${Date.now() - t0}ms`);
        return await this._consumeStream(stream, onChunk, t0);
      } catch (err) {
        console.warn(`[AI] ${model} failed (${err.message}), falling back to minimax`);
        // Try minimax fallback
        try {
          client = nvidiaClient; model = NVIDIA_MODEL_FALLBACK; provider = 'nvidia-minimax';
          const stream = await client.chat.completions.create(withModel(params, model));
          console.log(`[AI-PERF] ${provider} (${model}) stream open: ${Date.now() - t0}ms`);
          return await this._consumeStream(stream, onChunk, t0);
        } catch (err2) {
          console.warn(`[AI] ${model} failed (${err2.message}), falling back to opencode`);
          client = opencodeClient; model = OPENCODE_MODEL; provider = 'opencode';
          const stream = await client.chat.completions.create(withModel(params, model));
          console.log(`[AI-PERF] ${provider} stream open: ${Date.now() - t0}ms`);
          return await this._consumeStream(stream, onChunk, t0);
        }
      }
    } else {
      try {
        client = opencodeClient; model = OPENCODE_MODEL; provider = 'opencode';
        const stream = await client.chat.completions.create(withModel(params, model));
        console.log(`[AI-PERF] ${provider} stream open: ${Date.now() - t0}ms`);
        return await this._consumeStream(stream, onChunk, t0);
      } catch (err) {
        console.warn(`[AI] ${provider} failed (${err.message}), falling back to NVIDIA`);
        client = nvidiaClient; model = NVIDIA_MODEL_PRIMARY; provider = 'nvidia-step3.7';
        const stream = await client.chat.completions.create(withModel(params, model));
        console.log(`[AI-PERF] ${provider} stream open: ${Date.now() - t0}ms`);
        return await this._consumeStream(stream, onChunk, t0);
      }
    }
  }

  async _consumeStream(stream, onChunk, t0) {
    let fullResponse = '', isReasoning = false, firstChunk = false, chunks = 0;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (!firstChunk) { firstChunk = true; console.log(`[AI-PERF] TTFT: ${Date.now() - t0}ms`); }
      chunks++;

      // Handle reasoning_content (for models like step-3.7-flash)
      const reasoning = delta.reasoning_content;
      if (reasoning) {
        if (!isReasoning) { if (onChunk) onChunk('<think>\n'); fullResponse += '<think>\n'; isReasoning = true; }
        if (onChunk) onChunk(reasoning); fullResponse += reasoning;
      }

      // Handle regular content
      const content = delta.content || '';
      if (content) {
        if (isReasoning) { if (onChunk) onChunk('\n</think>\n'); fullResponse += '\n</think>\n'; isReasoning = false; }
        if (onChunk) onChunk(content); fullResponse += content;
      }
    }
    if (isReasoning) { if (onChunk) onChunk('\n</think>\n'); fullResponse += '\n</think>\n'; }
    console.log(`[AI-PERF] Total: ${Date.now() - t0}ms | chunks: ${chunks} | len: ${fullResponse.length}`);
    return fullResponse;
  }

  // ── Chat non-streaming ──────────────────────────────────────────────────────
  async chatComplete(messages, userId = null) {
    const systemPrompt = await this.buildSystemPrompt(messages, userId);
    // Sliding window: chỉ gửi MAX_CHAT_WINDOW message cuối lên model
    const trimmed = messages.length > MAX_CHAT_WINDOW ? messages.slice(-MAX_CHAT_WINDOW) : messages;
    if (messages.length > MAX_CHAT_WINDOW) {
      console.log(`[AI-PERF] Trimmed ${messages.length} → ${trimmed.length} messages (window=${MAX_CHAT_WINDOW})`);
    }
    const allMessages = [{ role: 'system', content: systemPrompt }, ...trimmed];
    const params = { messages: allMessages, stream: false, max_tokens: MAX_TOKENS, temperature: 0.4, top_p: 0.9 };
    const preferredProvider = process.env.AI_PROVIDER || 'nvidia';

    if (preferredProvider === 'nvidia') {
      // Try step-3.7-flash first
      try {
        const res = await nvidiaClient.chat.completions.create(withModel(params, NVIDIA_MODEL_PRIMARY));
        const content = res.choices[0]?.message?.content;
        const reasoning = res.choices[0]?.message?.reasoning_content;
        // step-3.7 trả cả reasoning_content (<think>) lẫn content; với reasoning_effort='low'
        // content là câu trả lời thật → ưu tiên content, chỉ fallback reasoning nếu content rỗng.
        return content || reasoning || 'Không có phản hồi';
      } catch (err) {
        console.warn(`[AI] ${NVIDIA_MODEL_PRIMARY} failed (${err.message}), falling back to minimax`);
        // Try minimax fallback
        try {
          const res = await nvidiaClient.chat.completions.create(withModel(params, NVIDIA_MODEL_FALLBACK));
          return res.choices[0]?.message?.content || 'Không có phản hồi';
        } catch (err2) {
          console.warn(`[AI] ${NVIDIA_MODEL_FALLBACK} failed (${err2.message}), falling back to opencode`);
          const res = await opencodeClient.chat.completions.create(withModel(params, OPENCODE_MODEL));
          return res.choices[0]?.message?.content || 'Không có phản hồi';
        }
      }
    } else {
      try {
        const res = await opencodeClient.chat.completions.create(withModel(params, OPENCODE_MODEL));
        return res.choices[0]?.message?.content || 'Không có phản hồi';
      } catch (err) {
        console.warn(`[AI] opencode failed (${err.message}), falling back to NVIDIA`);
        const res = await nvidiaClient.chat.completions.create(withModel(params, NVIDIA_MODEL_PRIMARY));
        const content = res.choices[0]?.message?.content;
        const reasoning = res.choices[0]?.message?.reasoning_content;
        return content || reasoning || 'Không có phản hồi';
      }
    }
  }

  // ── Gợi ý lịch trình ───────────────────────────────────────────────────────
  async suggestItinerary(destination, days, budget, interests) {
    const prompt = `Hãy tạo lịch trình du lịch ${destination} trong ${days} ngày với ngân sách ${budget}. 
Sở thích: ${interests.join(', ')}.
Hãy đưa ra lịch trình chi tiết theo từng ngày, bao gồm:
- Địa điểm tham quan
- Nhà hàng/quán ăn gợi ý
- Khách sạn phù hợp ngân sách
- Chi phí ước tính cho mỗi hoạt động`;
    return this.chatComplete([{ role: 'user', content: prompt }]);
  }

  // ── Gợi ý điểm đến ────────────────────────────────────────────────────────
  async suggestDestinations(preferences) {
    const { travelStyle, budget, interests, duration } = preferences;
    const prompt = `Dựa trên sở thích sau, hãy gợi ý 5 điểm đến du lịch phù hợp tại Việt Nam:
- Loại hình: ${travelStyle?.join(', ') || 'đa dạng'}
- Ngân sách: ${budget || 'trung bình'}
- Sở thích: ${interests?.join(', ') || 'khám phá'}
- Thời gian: ${duration || '3-5 ngày'}`;
    return this.chatComplete([{ role: 'user', content: prompt }]);
  }

  // ── Hỏi về điểm đến cụ thể ───────────────────────────────────────────────
  async askAboutDestination(destination, question) {
    return this.chatComplete([{ role: 'user', content: `Về điểm đến ${destination}: ${question}` }]);
  }

  // ── Tạo tour cộng đồng bằng AI (cho admin) ───────────────────────────────
  // Trả về object tour DRAFT (chưa có ảnh, chưa lưu DB). Route admin sẽ fill ảnh
  // qua Serper rồi cho admin review trước khi lưu.
  async generateTour(answers = {}) {
    const sys = `Bạn là chuyên gia thiết kế tour du lịch Việt Nam. Dựa trên yêu cầu của admin, hãy tạo MỘT tour hoàn chỉnh.

QUY TẮC BẮT BUỘC:
- ƯU TIÊN TUYỆT ĐỐI chọn trạm từ "DANH SÁCH ĐIỂM ĐẾN CÓ THẬT" cung cấp bên dưới, và PHẢI dùng ĐÚNG toạ độ [lat,lng] kèm theo mỗi điểm.
- BẮT BUỘC đưa vào tour những điểm NỔI TIẾNG / BIỂU TƯỢNG nhất của khu vực nếu chúng có trong danh sách (vd các địa danh đứng đầu danh sách).
- TUYỆT ĐỐI KHÔNG bịa toạ độ. Nếu một điểm KHÔNG có trong danh sách và bạn không chắc chắn toạ độ thật, ĐỪNG thêm điểm đó.
- MỌI trạm phải nằm ĐÚNG khu vực/tỉnh được yêu cầu — KHÔNG đưa điểm ở tỉnh khác.
- Số trạm hợp lý theo số ngày (khoảng 2-4 trạm/ngày).
- Mọi nội dung văn bản bằng tiếng Việt.
- Trả về DUY NHẤT một object JSON hợp lệ. KHÔNG kèm giải thích, KHÔNG markdown, KHÔNG dấu \`\`\`.

ĐỊNH DẠNG JSON (đúng tên field, KHÔNG thêm field ảnh — hệ thống tự lấy ảnh):
{
  "title": "tiêu đề hấp dẫn",
  "description": "mô tả 2-3 câu",
  "duration": "vd '3 ngày 2 đêm'",
  "days": number,
  "category": "một trong: Biển, Núi, Di sản, Thành phố, Sinh thái, Đảo, Văn hóa",
  "categoryIcon": "1 emoji",
  "region": "vd 'Miền Trung', 'Tây Nam Bộ'",
  "priceRange": "budget | mid-range | luxury",
  "priceLabel": "vd '5.500.000 ₫'",
  "rating": number (4.0-5.0),
  "reviewCount": number (50-600),
  "tags": ["4 thẻ ngắn"],
  "highlights": ["4 điểm nhấn"],
  "badge": "nhãn ngắn kèm emoji, vd '🔥 Phổ biến'",
  "badgeColor": "class tailwind, vd 'bg-red-500'",
  "author": "tên người tạo",
  "authorAvatar": "2 chữ cái viết tắt",
  "completedDate": "vd '04/2026'",
  "stops": [
    { "name": "...", "city": "...", "category": "beach|mountain|nature|heritage|city|island|countryside", "rating": number, "description": "mô tả ngắn", "coordinates": { "lat": number, "lng": number } }
  ],
  "reviews": [
    { "name": "...", "avatar": "2 chữ", "date": "vd '03/2026'", "rating": number, "text": "review chân thực", "helpful": number }
  ]
}
Tạo 2-3 review mẫu chân thực.`;

    // ── Neo dữ liệu: nạp điểm đến CÓ THẬT từ DB (đồ án tập trung Trà Vinh + Bến Tre) ──
    const Destination = require('../models/Destination');
    const optimizeService = require('./optimizeService');

    const norm = (s) => String(s || '').toLowerCase().trim();
    // Model lưu toạ độ ở location.coordinates; fallback top-level coordinates nếu có.
    const getCoords = (d) => {
      const c = (d?.location?.coordinates && typeof d.location.coordinates.lat === 'number')
        ? d.location.coordinates : d?.coordinates;
      return (c && typeof c.lat === 'number' && typeof c.lng === 'number') ? { lat: c.lat, lng: c.lng } : null;
    };

    let allDests = [];
    try {
      allDests = await Destination.find({}, 'name location coordinates category rating description isIconic iconicRank').lean();
    } catch (e) {
      console.warn('[generateTour] load destinations lỗi:', e.message);
    }

    // Ứng viên theo khu vực (khớp city hoặc tên); rỗng → lấy điểm biểu tượng toàn bộ.
    const area = norm(answers.destination);
    const byRank = (a, b) =>
      ((b.isIconic ? 1 : 0) - (a.isIconic ? 1 : 0)) ||
      ((a.iconicRank || 999) - (b.iconicRank || 999)) ||
      ((b.rating || 0) - (a.rating || 0));
    let candidates = allDests;
    let areaMatched = false;
    if (area) {
      const matched = allDests.filter((d) => {
        const city = norm(d.location?.city);
        return (city && (city.includes(area) || area.includes(city))) || norm(d.name).includes(area);
      });
      if (matched.length > 0) { candidates = matched; areaMatched = true; }
    }

    // Chỉ NEO danh sách điểm-có-thật khi: admin để AI tự chọn vùng (area rỗng) HOẶC
    // khu vực yêu cầu KHỚP dữ liệu DB. Nếu admin nhập một vùng mà DB chưa có điểm nào
    // (vd 'Đà Nẵng' khi DB tập trung Trà Vinh/Bến Tre) → KHÔNG gửi danh sách trái vùng
    // (tránh nhiễm điểm tỉnh khác); để AI tự dựng từ kiến thức đúng khu vực — toạ độ
    // thiếu sẽ được TourMap geocode runtime qua Nominatim.
    const useCandidates = !area || areaMatched;
    let candidateBlock = '';
    if (useCandidates) {
      candidates = [...candidates].sort(byRank).slice(0, 40);
      candidateBlock = candidates.map((d) => {
        const c = getCoords(d);
        return `- ${d.name}${d.location?.city ? ` (${d.location.city})` : ''}${c ? ` [${c.lat},${c.lng}]` : ''}`;
      }).join('\n');
    }

    const lines = [
      `- Điểm đến / khu vực: ${answers.destination || 'gợi ý điểm phù hợp ở Việt Nam'}`,
      `- Số ngày: ${answers.days || 3}`,
      `- Ngân sách: ${answers.budget || 'trung bình'}`,
      `- Sở thích / chủ đề: ${answers.interests || 'khám phá tổng hợp'}`,
      `- Đối tượng đi: ${answers.audience || 'mọi đối tượng'}`,
      `- Nhịp độ: ${answers.pace || 'cân bằng'}`,
    ];
    // Các tùy chọn mở rộng — chỉ thêm khi có ý nghĩa (bỏ qua "bất kỳ"/"tự do").
    if (answers.season && answers.season !== 'bất kỳ') lines.push(`- Mùa/thời điểm đi: ${answers.season} (chọn điểm đến & hoạt động hợp mùa, tránh thời tiết xấu)`);
    if (answers.transport && answers.transport !== 'tự do') lines.push(`- Phương tiện di chuyển: ${answers.transport} (sắp xếp lộ trình & khoảng cách phù hợp)`);
    if (answers.accommodation && answers.accommodation !== 'tự do') lines.push(`- Loại lưu trú ưu tiên: ${answers.accommodation}`);
    if (answers.fitness) lines.push(`- Mức thể lực: ${answers.fitness}`);
    if (answers.density) lines.push(`- Mật độ điểm mỗi ngày: ${answers.density}`);
    if (answers.notes && String(answers.notes).trim()) lines.push(`- Yêu cầu riêng (BẮT BUỘC tôn trọng): ${String(answers.notes).trim()}`);

    let userMsg = `Yêu cầu tour:\n${lines.join('\n')}`;
    if (candidateBlock) {
      userMsg += `\n\nDANH SÁCH ĐIỂM ĐẾN CÓ THẬT (ưu tiên chọn, dùng ĐÚNG toạ độ [lat,lng]; BẮT BUỘC gồm các điểm nổi tiếng nhất đứng đầu danh sách):\n${candidateBlock}`;
    }

    const messages = [{ role: 'system', content: sys }, { role: 'user', content: userMsg }];
    const params = { messages, stream: false, max_tokens: MAX_TOKENS_TOUR, temperature: 0.6, top_p: 0.9 };

    // Gọi model theo chuỗi fallback giống chatComplete: nvidia primary → minimax → opencode.
    const callRaw = async () => {
      try {
        const res = await nvidiaClient.chat.completions.create(withModel(params, NVIDIA_MODEL_PRIMARY));
        return res.choices[0]?.message?.content || res.choices[0]?.message?.reasoning_content;
      } catch (err) {
        console.warn(`[generateTour] ${NVIDIA_MODEL_PRIMARY} failed (${err.message}), thử minimax`);
        try {
          const res = await nvidiaClient.chat.completions.create(withModel(params, NVIDIA_MODEL_FALLBACK));
          return res.choices[0]?.message?.content;
        } catch (err2) {
          console.warn(`[generateTour] minimax failed (${err2.message}), thử opencode`);
          const res = await opencodeClient.chat.completions.create(withModel(params, OPENCODE_MODEL));
          return res.choices[0]?.message?.content;
        }
      }
    };

    // Model reasoning thỉnh thoảng trả JSON cụt (hết token) hoặc kèm text → parse lỗi.
    // Thử tối đa 2 lần trước khi báo lỗi để admin không mất trắng lần gọi.
    let draft, lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let raw;
      try {
        raw = await callRaw();
      } catch (err) {
        lastErr = err;
        console.warn(`[generateTour] gọi model lỗi (lần ${attempt}): ${err.message}`);
        continue;
      }
      if (!raw) { lastErr = new Error('AI không trả về nội dung'); continue; }
      try {
        draft = this._parseTourJson(raw);
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[generateTour] parse JSON lỗi (lần ${attempt}): ${err.message}`);
      }
    }
    if (!draft) throw lastErr || new Error('Không tạo được tour');

    // ── Neo toạ độ từng trạm theo DB: đè toạ độ AI nếu trạm khớp tên một điểm thật ──
    const matchDest = (stopName) => {
      const n = norm(stopName);
      if (!n) return null;
      let best = allDests.find((d) => norm(d.name) === n);
      if (best) return best;
      best = allDests.find((d) => { const dn = norm(d.name); return dn.length >= 4 && (n.includes(dn) || dn.includes(n)); });
      return best || null;
    };
    let groundedCount = 0;
    for (const s of draft.stops) {
      const m = matchDest(s.name);
      if (!m) continue;
      const c = getCoords(m);
      if (c) { s.coordinates = c; groundedCount++; }
      if (!s.city && m.location?.city) s.city = m.location.city;
    }

    // ── Ép đưa các điểm BIỂU TƯỢNG của khu vực vào tour (vd Ao Bà Om, Ba Động) ──
    // AI hay bỏ sót điểm nổi tiếng → bổ sung tất định từ DB (isIconic) nếu còn thiếu.
    if (areaMatched) {
      const mapCat = (c) => {
        if (['beach', 'mountain', 'city', 'countryside'].includes(c)) return c;
        if (['historical', 'temple', 'culture', 'landmark'].includes(c)) return 'heritage';
        return 'nature';
      };
      const hasStop = (name) => draft.stops.some((s) => {
        const a = norm(s.name), b = norm(name);
        return a === b || (b.length >= 4 && (a.includes(b) || b.includes(a)));
      });
      const mustHave = candidates
        .filter((d) => d.isIconic && getCoords(d))
        .sort((a, b) => (a.iconicRank || 999) - (b.iconicRank || 999))
        .slice(0, 5);
      for (const d of mustHave) {
        if (hasStop(d.name)) continue;
        draft.stops.push({
          name: d.name,
          city: d.location?.city || '',
          category: mapCat(d.category),
          rating: d.rating || 4.6,
          description: d.description || `Địa danh nổi tiếng tại ${d.location?.city || 'khu vực'}.`,
          coordinates: getCoords(d),
        });
        groundedCount++;
      }
    }

    // Nếu AI không tạo được trạm nào (kể cả sau khi bổ sung điểm biểu tượng) → báo lỗi rõ
    // để admin thử lại, thay vì trả về tour rỗng phải tự thêm tay.
    if (!draft.stops.length) {
      throw new Error('AI chưa tạo được trạm dừng nào — vui lòng thử lại hoặc nêu rõ khu vực hơn.');
    }

    // ── Tối ưu thứ tự trạm: "gần nhất kế tiếp" (Nearest Neighbor) như trang chat AI ──
    try {
      const hasCoords = (s) => s.coordinates && typeof s.coordinates.lat === 'number';
      const withCoords = draft.stops.filter(hasCoords);
      if (withCoords.length >= 2) {
        const locations = withCoords.map((s) => ({ lat: s.coordinates.lat, lng: s.coordinates.lng, _stop: s }));
        const result = await optimizeService.optimizeRoute(locations, { lat: locations[0].lat, lng: locations[0].lng }, 'auto');
        const ordered = result.optimizedLocations.map((l) => l._stop);
        draft.stops = [...ordered, ...draft.stops.filter((s) => !hasCoords(s))];
        console.log(`[generateTour] ✓ neo ${groundedCount}/${draft.stops.length} trạm theo DB | tối ưu ${result.stats.locationCount} trạm (${result.method}, tiết kiệm ${result.stats.improvementPercent}%)`);
      }
    } catch (optErr) {
      console.warn('[generateTour] optimize lỗi:', optErr.message);
    }

    return draft;
  }

  // Bóc + parse JSON tour từ phản hồi model (strip <think>, bỏ fence, lấy {...}).
  _parseTourJson(text) {
    let s = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first !== -1 && last !== -1) s = s.slice(first, last + 1);

    let obj;
    try {
      obj = JSON.parse(s);
    } catch (e) {
      throw new Error('AI trả về JSON không hợp lệ: ' + e.message);
    }

    // Normalize — đảm bảo kiểu dữ liệu để khớp model Tour.
    const num = (v, d = 0) => (typeof v === 'number' && !isNaN(v) ? v : (parseFloat(v) || d));
    const arr = (v) => (Array.isArray(v) ? v : []);
    return {
      title: obj.title || 'Tour mới',
      description: obj.description || '',
      duration: obj.duration || `${num(obj.days, 1)} ngày`,
      days: num(obj.days, 1),
      category: obj.category || 'Khám phá',
      categoryIcon: obj.categoryIcon || '📍',
      region: obj.region || '',
      priceRange: ['budget', 'mid-range', 'luxury'].includes(obj.priceRange) ? obj.priceRange : 'mid-range',
      priceLabel: obj.priceLabel || 'Liên hệ',
      rating: num(obj.rating, 4.5),
      reviewCount: num(obj.reviewCount, 0),
      tags: arr(obj.tags).map(String),
      highlights: arr(obj.highlights).map(String),
      badge: obj.badge || '✨ Mới',
      badgeColor: obj.badgeColor || 'bg-sky-500',
      author: obj.author || 'TravelAI',
      authorAvatar: obj.authorAvatar || 'AI',
      completedDate: obj.completedDate || '',
      stops: arr(obj.stops).map((s) => ({
        name: s.name || '',
        city: s.city || '',
        category: s.category || 'nature',
        rating: num(s.rating, 4.5),
        description: s.description || '',
        coordinates: (s.coordinates && typeof s.coordinates.lat === 'number')
          ? { lat: num(s.coordinates.lat), lng: num(s.coordinates.lng) }
          : undefined,
      })),
      reviews: arr(obj.reviews).map((r) => ({
        name: r.name || 'Khách',
        avatar: r.avatar || (r.name ? r.name.slice(0, 2).toUpperCase() : 'KH'),
        date: r.date || '',
        rating: num(r.rating, 5),
        text: r.text || '',
        helpful: num(r.helpful, 0),
      })),
    };
  }
}

module.exports = new AIService();
