'use client';
import { useState, useMemo, useEffect, useRef } from 'react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import TourDetailModal, { PRICE_CONFIG, useTourSaved } from '../components/TourDetailModal';
import { toggleSavedTour, type Tour } from '../lib/savedTours';
import { getTours } from '../lib/tours';


const CATEGORIES = [
  { id: '', label: 'Tất cả', icon: '🌏' },
  { id: 'Biển', label: 'Biển & Đảo', icon: '🏖️' },
  { id: 'Núi', label: 'Núi rừng', icon: '🏔️' },
  { id: 'Di sản', label: 'Di sản', icon: '🏛️' },
  { id: 'Thành phố', label: 'Thành phố', icon: '🏙️' },
];

const SORT_OPTIONS = [
  { id: 'rating', label: '⭐ Đánh giá cao nhất' },
  { id: 'reviews', label: '💬 Nhiều đánh giá' },
  { id: 'views', label: '👁️ Xem nhiều nhất' },
  { id: 'price-asc', label: '💰 Chi phí thấp nhất' },
];

const PRICE_FILTERS = [
  { id: '', label: 'Mọi mức giá' },
  { id: 'budget', label: '💚 Tiết kiệm' },
  { id: 'mid-range', label: '💙 Tầm trung' },
  { id: 'luxury', label: '💜 Cao cấp' },
];

// ── Tour Showcase Hero (banner ảnh full-bleed xoay vòng, giống TravelShowcase trang chủ) ──
function TourShowcase({ tours, onOpen }: { tours: Tour[]; onOpen: (t: Tour) => void }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [auto, setAuto] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const active = tours[activeIndex];

  // Tự động chuyển tour mỗi 5s khi đang bật auto
  useEffect(() => {
    if (!auto || tours.length <= 1) return;
    const id = setInterval(() => setActiveIndex((i) => (i + 1) % tours.length), 5000);
    return () => clearInterval(id);
  }, [auto, tours.length]);

  const select = (i: number) => { setActiveIndex(i); setAuto(false); };
  const scroll = (dir: 'left' | 'right') => {
    scrollRef.current?.scrollBy({ left: dir === 'right' ? 220 : -220, behavior: 'smooth' });
  };

  if (!active) return null;

  return (
    <div className="relative h-[460px] sm:h-[520px] w-full overflow-hidden">
      {/* Ảnh nền của tour đang active */}
      <img
        key={active.coverImage}
        src={active.coverImage}
        alt={active.title}
        className="absolute inset-0 h-full w-full object-cover tour-hero-fade"
      />
      {/* Lớp phủ gradient cho dễ đọc chữ */}
      <div className="absolute inset-0 bg-gradient-to-r from-black/75 via-black/40 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 to-transparent" />

      {/* Counter góc trên phải */}
      <div className="absolute top-5 right-5 z-20 rounded-full bg-black/40 px-3 py-1 text-xs font-bold text-white backdrop-blur">
        {String(activeIndex + 1).padStart(2, '0')} / {String(tours.length).padStart(2, '0')}
      </div>

      <div className="relative z-10 mx-auto flex h-full max-w-7xl items-end justify-between gap-6 px-4 sm:px-6 lg:px-8 pb-10 lg:pb-12">
        {/* Thông tin tour bên trái */}
        <div className="max-w-2xl text-white">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold text-white shadow ${active.badgeColor}`}>
              {active.badge}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur">
              <span>📍</span>{active.region}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold backdrop-blur">
              <span>⏱️</span>{active.duration}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-amber-300 backdrop-blur">
              ⭐ {active.rating.toFixed(1)} <span className="text-white/60">({active.reviewCount})</span>
            </span>
          </div>

          <h2 className="mb-3 text-2xl font-black leading-tight drop-shadow sm:text-4xl lg:text-5xl">
            <span className="mr-1.5">{active.categoryIcon}</span>{active.title}
          </h2>

          <p className="mb-6 max-w-xl text-sm leading-relaxed text-white/85 line-clamp-2 sm:text-base">
            {active.description}
          </p>

          <div className="flex flex-wrap items-center gap-4">
            <button
              onClick={() => onOpen(active)}
              className="rounded-full bg-white px-6 py-3 font-bold text-gray-900 shadow-lg transition-all hover:scale-105"
            >
              Xem chi tiết →
            </button>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xs text-white/70">Giá từ</span>
              <span className="text-2xl font-black text-amber-300">{active.priceLabel}</span>
            </div>
            <button
              onClick={() => setAuto((v) => !v)}
              title={auto ? 'Tạm dừng tự động lướt' : 'Tự động lướt'}
              className="ml-auto flex h-11 w-11 items-center justify-center rounded-full border-2 border-white/70 text-white transition-all hover:bg-white hover:text-gray-900"
            >
              {auto ? (
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
              ) : (
                <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              )}
            </button>
          </div>

          {/* Dots cho mobile (thumbnail bị ẩn) */}
          <div className="mt-6 flex gap-1.5 lg:hidden">
            {tours.map((_, i) => (
              <button
                key={i}
                onClick={() => select(i)}
                aria-label={`Tour ${i + 1}`}
                className={`h-1.5 rounded-full transition-all ${i === activeIndex ? 'w-6 bg-white' : 'w-1.5 bg-white/50'}`}
              />
            ))}
          </div>
        </div>

        {/* Thumbnail các tour khác bên phải (desktop) */}
        <div className="relative hidden lg:block">
          <button
            onClick={() => scroll('left')}
            className="absolute -left-4 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-gray-900 shadow-lg transition-all hover:scale-110 hover:bg-white"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          <button
            onClick={() => scroll('right')}
            className="absolute -right-4 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-gray-900 shadow-lg transition-all hover:scale-110 hover:bg-white"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>

          <div ref={scrollRef} className="flex max-w-[46vw] gap-3 overflow-x-auto pb-2 scrollbar-hide">
            {tours.map((t, i) => (
              <button
                key={t.id}
                onClick={() => select(i)}
                className={`group relative h-[180px] w-[150px] flex-shrink-0 overflow-hidden rounded-2xl shadow-xl transition-all ${
                  i === activeIndex ? 'scale-105 ring-4 ring-white' : 'opacity-80 hover:scale-105 hover:opacity-100'
                }`}
              >
                <img src={t.coverImage} alt={t.title} className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-110" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 p-3 text-left">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-white/70">{t.region}</p>
                  <p className="line-clamp-2 text-xs font-bold leading-tight text-white">{t.title}</p>
                  <p className="mt-1 text-[11px] font-black text-amber-300">{t.priceLabel}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Tour Card ─────────────────────────────────────────────────────────────────
function TourCard({ tour, onOpen }: { tour: Tour; onOpen: () => void }) {
  const priceConf = PRICE_CONFIG[tour.priceRange];
  const tierText = priceConf.color.split(' ')[0]; // class text-color theo bậc giá
  const saved = useTourSaved(tour.id);
  return (
    <div
      onClick={onOpen}
      className="group bg-white rounded-3xl shadow-md hover:shadow-2xl transition-all duration-500 overflow-hidden cursor-pointer border border-gray-100 hover:-translate-y-2 flex flex-col"
    >
      {/* Image */}
      <div className="relative h-48 overflow-hidden">
        <img
          src={tour.coverImage}
          alt={tour.title}
          className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700"
        />
        <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/45 to-transparent pointer-events-none" />

        {/* Badge bậc giá: pill trắng, chữ màu theo bậc */}
        <div className={`absolute top-3 left-3 px-3 py-1 rounded-full bg-white/95 backdrop-blur text-xs font-bold shadow-sm ${tierText}`}>
          {priceConf.label}
        </div>

        {/* Chip rating */}
        <div className="absolute top-3 right-3 px-2 py-1 rounded-full bg-white/95 backdrop-blur text-xs font-bold text-amber-600 shadow-sm">
          ⭐ {tour.rating.toFixed(1)}
        </div>

        {/* Nút lưu tour */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleSavedTour(tour); }}
          title={saved ? 'Bỏ lưu tour' : 'Lưu tour'}
          className={`absolute top-3 left-1/2 -translate-x-1/2 w-9 h-9 rounded-full flex items-center justify-center shadow-sm backdrop-blur transition-all opacity-0 group-hover:opacity-100 ${
            saved ? 'bg-red-500 text-white opacity-100' : 'bg-white/95 text-gray-600 hover:bg-red-500 hover:text-white'
          }`}
        >
          <svg className="w-[18px] h-[18px]" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
          </svg>
        </button>

        {/* Xem nhanh */}
        <button
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/55 hover:bg-black/75 backdrop-blur text-white text-xs font-semibold transition-all"
        >
          👁️ Xem nhanh
        </button>
      </div>

      {/* Card Body */}
      <div className="p-4 flex flex-col flex-1">
        {/* Title */}
        <h2 className="font-bold text-gray-900 text-[15px] leading-snug line-clamp-2 mb-2 min-h-[42px]">
          <span className="mr-1">{tour.categoryIcon}</span>{tour.title}
        </h2>

        {/* Vị trí + thời lượng */}
        <div className="flex items-center justify-between text-xs text-gray-500 mb-3">
          <span className="flex items-center gap-1 truncate"><span className="text-sky-500">📍</span>{tour.region}</span>
          <span className="flex items-center gap-1 flex-shrink-0"><span className="text-violet-500">⏱️</span>{tour.duration}</span>
        </div>

        {/* Giá + CTA */}
        <div className="border-t border-gray-100 mt-auto pt-3 flex items-end justify-between">
          <div>
            <p className="text-[11px] text-gray-400 font-medium">Giá từ:</p>
            <p className="text-xl font-black text-orange-600 leading-tight">{tour.priceLabel}</p>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            className="px-4 py-2.5 bg-gradient-to-b from-blue-500 to-blue-700 text-white rounded-lg font-bold text-sm shadow-md hover:from-blue-600 hover:to-blue-800 hover:shadow-lg hover:shadow-blue-500/30 transition-all active:scale-95"
          >
            Xem chi tiết
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function MyToursPage() {
  const [activeCategory, setActiveCategory] = useState('');
  const [sortBy, setSortBy] = useState('rating');
  const [priceFilter, setPriceFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTour, setSelectedTour] = useState<Tour | null>(null);

  // Tour giờ tải từ DB qua API (trước đây hardcode trong file này).
  const [tours, setTours] = useState<Tour[]>([]);
  const [loadingTours, setLoadingTours] = useState(true);

  useEffect(() => {
    let alive = true;
    getTours()
      .then((data) => { if (alive) setTours(data); })
      .catch(() => { if (alive) setTours([]); })
      .finally(() => { if (alive) setLoadingTours(false); });
    return () => { alive = false; };
  }, []);

  const openTour = (tour: Tour) => {
    setSelectedTour(tour);
    document.body.style.overflow = 'hidden';
  };
  const closeTour = () => {
    setSelectedTour(null);
    document.body.style.overflow = '';
  };

  const filteredTours = useMemo(() => {
    const PRICE_ORDER = { budget: 1, 'mid-range': 2, luxury: 3 };
    // Chuẩn hoá bỏ dấu để tìm kiếm thân thiện tiếng Việt (gõ "da nang" vẫn ra "Đà Nẵng").
    const norm = (s: string) =>
      (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd');
    const q = norm(searchQuery.trim());
    let list = tours
      .filter((t) => !activeCategory || t.category === activeCategory)
      .filter((t) => !priceFilter || t.priceRange === priceFilter)
      .filter((t) => !q ||
        norm(t.title).includes(q) ||
        norm(t.region).includes(q) ||
        (t.tags || []).some((tag) => norm(tag).includes(q)));
    list.sort((a, b) => {
      if (sortBy === 'rating')    return b.rating - a.rating;
      if (sortBy === 'reviews')   return b.reviewCount - a.reviewCount;
      if (sortBy === 'views')     return b.viewCount - a.viewCount;
      if (sortBy === 'price-asc') return PRICE_ORDER[a.priceRange] - PRICE_ORDER[b.priceRange];
      return 0;
    });
    return list;
  }, [tours, activeCategory, sortBy, priceFilter, searchQuery]);

  // Tour nổi bật cho banner: 6 tour nhiều lượt xem nhất
  const featuredTours = useMemo(
    () => [...tours].sort((a, b) => b.viewCount - a.viewCount).slice(0, 6),
    [tours]
  );


  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-sky-50/40 to-violet-50/20">
      <Navbar />

      {/* ── Hero ── */}
      <div className="pt-20">
        {/* Header gọn */}
        <div className="bg-gradient-to-br from-slate-50 via-white to-sky-50 px-4 py-8 sm:py-10">
          <div className="mx-auto max-w-7xl">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-white/80 border border-sky-100 rounded-full shadow-sm mb-4">
              <span className="text-lg">🏕️</span>
              <span className="text-sm font-semibold text-sky-600 uppercase tracking-wide">Tours từ cộng đồng du lịch</span>
            </div>
            <h1 className="text-3xl md:text-5xl font-black text-gray-900 leading-tight">
              Khám phá Tours{' '}
              <span className="bg-gradient-to-r from-sky-500 via-violet-500 to-pink-500 bg-clip-text text-transparent">
                được yêu thích nhất
              </span>
            </h1>
            <p className="text-gray-500 text-base sm:text-lg max-w-2xl mt-3">
              Những hành trình thực tế từ du khách đã trải nghiệm — kèm bản đồ, trạm dừng và đánh giá chân thực. Chọn tour phù hợp và nhờ AI lên kế hoạch cho bạn.
            </p>
          </div>
        </div>

        {/* Banner ảnh xoay vòng các tour nổi bật */}
        <TourShowcase tours={featuredTours} onOpen={openTour} />
      </div>

      {/* ── Sticky Filter Bar ── */}
      <div className="sticky top-20 z-40 bg-white/92 backdrop-blur border-b border-gray-100 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
          {/* Category pills */}
          <div className="flex gap-2 overflow-x-auto pb-1 sm:pb-0 flex-wrap">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`flex-shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold border transition-all ${
                  activeCategory === cat.id
                    ? 'bg-gray-900 text-white border-gray-900 shadow-md'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300 hover:text-gray-900'
                }`}
              >
                <span>{cat.icon}</span>
                <span>{cat.label}</span>
              </button>
            ))}
          </div>

          {/* Search + Price + Sort */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm tour theo tên..."
                className="w-44 sm:w-56 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-xl pl-9 pr-8 py-2 focus:outline-none focus:ring-2 focus:ring-sky-300"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  aria-label="Xóa tìm kiếm"
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded-full hover:bg-gray-100 text-xs"
                >✕</button>
              )}
            </div>
            <select
              value={priceFilter}
              onChange={(e) => setPriceFilter(e.target.value)}
              className="text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-300 cursor-pointer"
            >
              {PRICE_FILTERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="text-sm font-semibold text-gray-700 bg-white border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-300 cursor-pointer"
            >
              {SORT_OPTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* ── Tour Grid ── */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <p className="text-sm text-gray-400 font-medium mb-6">
          Hiển thị <span className="text-gray-700 font-bold">{filteredTours.length}</span> tours
          {activeCategory && ` · ${activeCategory}`}
          {priceFilter && ` · ${PRICE_CONFIG[priceFilter as keyof typeof PRICE_CONFIG]?.label}`}
          {searchQuery.trim() && ` · “${searchQuery.trim()}”`}
        </p>

        {loadingTours ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-80 rounded-2xl bg-gray-100 animate-pulse" />
            ))}
          </div>
        ) : filteredTours.length === 0 ? (
          <div className="text-center py-20">
            <span className="text-6xl block mb-4">🔍</span>
            <p className="text-xl text-gray-400 font-medium">Không có tour nào phù hợp với bộ lọc</p>
            <button
              onClick={() => { setActiveCategory(''); setPriceFilter(''); setSearchQuery(''); }}
              className="mt-4 px-6 py-2.5 bg-sky-100 text-sky-700 font-semibold rounded-xl hover:bg-sky-200 transition-all"
            >
              Xóa bộ lọc
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {filteredTours.map((tour) => (
              <TourCard key={tour.id} tour={tour} onOpen={() => openTour(tour)} />
            ))}
          </div>
        )}


      </div>

      <Footer />

      {/* ── Tour Detail Modal ── */}
      {selectedTour && <TourDetailModal tour={selectedTour} onClose={closeTour} />}

      <style>{`
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
        @keyframes tourHeroFade { from { opacity: 0; transform: scale(1.04); } to { opacity: 1; transform: scale(1); } }
        .tour-hero-fade { animation: tourHeroFade 0.7s ease; }
      `}</style>
    </div>
  );
}
