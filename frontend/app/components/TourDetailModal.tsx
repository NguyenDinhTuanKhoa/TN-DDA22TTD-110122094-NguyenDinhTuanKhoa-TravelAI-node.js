'use client';
import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { saveNavPayload } from '../lib/navHandoff';
import { useAuth } from '../context/AuthContext';
import { useTourStatus, setTourStatus } from '../lib/tourProgress';
import TourReviewForm from './TourReviewForm';
import {
  type Tour,
  isTourSaved,
  toggleSavedTour,
  SAVED_TOURS_EVENT,
} from '../lib/savedTours';

// Bản đồ thật (Leaflet) — chỉ render phía client vì cần `window`.
const TourMap = dynamic(() => import('./TourMap'), {
  ssr: false,
  loading: () => (
    <div className="h-[460px] rounded-2xl bg-gradient-to-br from-sky-50 to-blue-50 border border-sky-100 flex items-center justify-center text-sm text-gray-400">
      Đang tải bản đồ…
    </div>
  ),
});

// ── Shared constants ────────────────────────────────────────────────────────
const CATEGORY_ICONS: Record<string, string> = {
  beach: '🏖️', mountain: '🏔️', city: '🏙️', countryside: '🌾',
  heritage: '🏛️', nature: '🌿', island: '🏝️', default: '📍',
};

export const PRICE_CONFIG = {
  'budget':    { label: 'Tiết kiệm', color: 'text-green-700 bg-green-50 border-green-200' },
  'mid-range': { label: 'Tầm trung', color: 'text-sky-700 bg-sky-50 border-sky-200' },
  'luxury':    { label: 'Cao cấp',   color: 'text-violet-700 bg-violet-50 border-violet-200' },
};

// Theo dõi trạng thái đã lưu của 1 tour, đồng bộ qua nhiều card/tab.
export function useTourSaved(id: string) {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const sync = () => setSaved(isTourSaved(id));
    sync();
    window.addEventListener(SAVED_TOURS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(SAVED_TOURS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [id]);
  return saved;
}

// ── Star component ──────────────────────────────────────────────────────────
export function Stars({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'lg' ? 'w-5 h-5' : size === 'md' ? 'w-4 h-4' : 'w-3 h-3';
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => {
        const full = rating >= i;
        const half = !full && rating >= i - 0.5;
        return (
          <svg key={i} className={`${sz} ${full || half ? 'text-yellow-400' : 'text-gray-200'}`} fill="currentColor" viewBox="0 0 20 20">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
        );
      })}
    </div>
  );
}

// ── Tour Detail Modal ─────────────────────────────────────────────────────────
export default function TourDetailModal({
  tour: initialTour,
  onClose,
  initialTab = 'map',
}: {
  tour: Tour;
  onClose: () => void;
  initialTab?: 'map' | 'nav' | 'stops' | 'reviews';
}) {
  // tour ở state cục bộ để cập nhật tại chỗ sau khi người dùng gửi đánh giá.
  const [tour, setTour] = useState(initialTour);
  const [activeTab, setActiveTab] = useState<'map' | 'nav' | 'stops' | 'reviews'>(initialTab);
  const saved = useTourSaved(tour.id);
  const status = useTourStatus(tour.id);
  const { user } = useAuth();
  const router = useRouter();

  // Đánh giá hiện có của chính user (để prefill form sửa).
  const myReview = user ? tour.reviews.find((r) => r.userId === user._id) : undefined;

  // Đánh dấu đã đi xong thủ công (dự phòng khi không qua màn dẫn đường).
  const markCompleted = () => {
    setTourStatus(tour.id, 'completed');
    setActiveTab('reviews');
  };

  // Tour ≥ 2 trạm: bấm "Bắt đầu đi" → đánh dấu 'going', mang tourId qua trang
  // dẫn đường riêng (/navigate). < 2 trạm: chuyển sang tab 'nav' để hiện cảnh báo.
  const startNavigation = () => {
    if (tour.stops.length < 2) { setActiveTab('nav'); return; }
    setTourStatus(tour.id, 'going');
    saveNavPayload({
      title: tour.title,
      tourId: tour.id,
      waypoints: tour.stops.map((s) => ({
        name: s.name,
        city: s.city,
        lat: s.coordinates?.lat,
        lng: s.coordinates?.lng,
      })),
    });
    router.push('/navigate');
  };
  // Bản đồ địa lý dùng chiều cao cố định (khác list dọc cũ cần cao theo số trạm).
  const mapHeight = 460;

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center p-3 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header image ── */}
        <div className="relative h-52 flex-shrink-0">
          <img src={tour.coverImage} alt={tour.title} className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />
          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-9 h-9 bg-black/50 hover:bg-black/70 backdrop-blur rounded-full flex items-center justify-center text-white transition-all text-lg font-bold"
          >
            ✕
          </button>
          {/* Badge */}
          {tour.badge && (
            <div className={`absolute top-4 left-4 px-3 py-1.5 ${tour.badgeColor} text-white text-xs font-bold rounded-full shadow-lg`}>
              {tour.badge}
            </div>
          )}
          {/* Bottom info */}
          <div className="absolute bottom-4 left-5 right-14">
            <p className="text-white/70 text-xs mb-1">{tour.categoryIcon} {tour.category} · {tour.duration} · {tour.region}</p>
            <h2 className="text-white text-xl font-black leading-tight">{tour.title}</h2>
            <div className="flex items-center gap-2 mt-1.5">
              <Stars rating={tour.rating} size="sm" />
              <span className="text-white font-bold text-sm">{tour.rating.toFixed(1)}</span>
              <span className="text-white/60 text-xs">({tour.reviewCount} đánh giá)</span>
            </div>
          </div>
        </div>

        {/* ── Author + price ── */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-sky-400 to-violet-500 flex items-center justify-center text-white text-xs font-bold">
              {tour.authorAvatar}
            </div>
            <div>
              <p className="text-xs text-gray-500">Chia sẻ bởi <span className="font-semibold text-gray-800">{tour.author}</span></p>
              <p className="text-xs text-gray-400">Đã hoàn thành {tour.completedDate}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => toggleSavedTour(tour)}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-bold border transition-all ${
                saved
                  ? 'bg-red-500 text-white border-red-500'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-red-300 hover:text-red-500'
              }`}
            >
              <svg className="w-4 h-4" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
              </svg>
              {saved ? 'Đã lưu' : 'Lưu tour'}
            </button>
            <div className={`px-4 py-1.5 rounded-full text-sm font-bold border ${PRICE_CONFIG[tour.priceRange].color}`}>
              ~{tour.priceLabel} / người
            </div>
          </div>
        </div>

        {/* ── Tab Bar ── */}
        <div className="flex border-b border-gray-100 flex-shrink-0 px-2">
          {([
            { id: 'map', label: '🎮 Bản đồ', count: null },
            { id: 'nav', label: '🧭 Dẫn đường', count: null },
            { id: 'stops', label: '📍 Trạm dừng', count: tour.stops.length },
            { id: 'reviews', label: '💬 Đánh giá', count: tour.reviewCount },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              onClick={() => (tab.id === 'nav' ? startNavigation() : setActiveTab(tab.id))}
              className={`flex items-center gap-1.5 px-5 py-3 text-sm font-semibold border-b-2 transition-all ${
                activeTab === tab.id
                  ? 'border-sky-500 text-sky-600'
                  : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              {tab.label}
              {tab.count !== null && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                  activeTab === tab.id ? 'bg-sky-100 text-sky-600' : 'bg-gray-100 text-gray-500'
                }`}>{tab.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── Tab Content ── */}
        <div className="overflow-y-auto flex-1">

          {/* MAP TAB */}
          {activeTab === 'map' && (
            <div className="p-5">
              <p className="text-sm text-gray-500 mb-4">{tour.description}</p>
              {/* Highlights */}
              <div className="grid grid-cols-2 gap-2 mb-5">
                {tour.highlights.map((h) => (
                  <div key={h} className="flex items-center gap-2 bg-green-50 border border-green-100 rounded-xl px-3 py-2">
                    <span className="text-green-500 font-bold text-base">✓</span>
                    <span className="text-sm text-gray-700 font-medium">{h}</span>
                  </div>
                ))}
              </div>

              {tour.stops.length === 0 ? (
                <p className="text-center text-sm text-gray-400 py-8">Tour này chưa có dữ liệu bản đồ. Hãy lưu lại từ trang Tours để cập nhật.</p>
              ) : (
                /* Bản đồ thật (Leaflet) — định vị các trạm qua geocoding */
                <div className="rounded-2xl overflow-hidden shadow-xl border border-gray-100">
                  <TourMap stops={tour.stops} height={mapHeight} />
                </div>
              )}
            </div>
          )}

          {/* NAVIGATION TAB — chỉ hiện khi tour < 2 trạm (≥ 2 trạm mở thẳng trang /navigate) */}
          {activeTab === 'nav' && (
            <div className="p-5">
              <p className="text-center text-sm text-gray-400 py-8">Tour này cần ít nhất 2 trạm để dẫn đường.</p>
            </div>
          )}

          {/* STOPS TAB */}
          {activeTab === 'stops' && (
            <div className="divide-y divide-gray-50">
              {tour.stops.map((stop, idx) => {
                const isFirst = idx === 0;
                const isLast = idx === tour.stops.length - 1;
                const icon = CATEGORY_ICONS[stop.category] || CATEGORY_ICONS.default;
                return (
                  <div key={idx} className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors">
                    {/* Step indicator */}
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center font-black text-sm shadow flex-shrink-0 ${
                      isFirst ? 'bg-emerald-400 text-white' : isLast ? 'bg-red-400 text-white' : 'bg-gradient-to-br from-sky-400 to-blue-600 text-white'
                    }`}>
                      {isFirst ? '▶' : isLast ? '🏁' : idx + 1}
                    </div>
                    {/* Image */}
                    <div className="w-14 h-14 rounded-xl overflow-hidden flex-shrink-0 shadow-sm">
                      <img src={stop.image} alt={stop.name} className="w-full h-full object-cover" />
                    </div>
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-gray-900 truncate">{stop.name}</p>
                      <p className="text-xs text-gray-500 truncate">{icon} {stop.description}</p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <Stars rating={stop.rating} size="sm" />
                        <span className="text-xs font-semibold text-gray-600">{stop.rating.toFixed(1)}</span>
                        <span className="text-xs text-gray-400">· {stop.city}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* REVIEWS TAB */}
          {activeTab === 'reviews' && (
            <div className="p-5 space-y-4">
              {/* Summary */}
              <div className="bg-gradient-to-br from-sky-50 to-violet-50 border border-sky-100 rounded-2xl p-5">
                <div className="flex items-center gap-4">
                  <div className="text-center">
                    <p className="text-5xl font-black text-gray-900">{tour.rating.toFixed(1)}</p>
                    <Stars rating={tour.rating} size="md" />
                    <p className="text-xs text-gray-500 mt-1">{tour.reviewCount} đánh giá</p>
                  </div>
                  <div className="flex-1 space-y-1.5">
                    {[5, 4, 3, 2, 1].map((star) => {
                      // Phân bố thật từ review (làm tròn rating về sao nguyên).
                      const count = tour.reviews.filter((r) => Math.round(r.rating) === star).length;
                      const pct = tour.reviews.length ? Math.round((count / tour.reviews.length) * 100) : 0;
                      return (
                        <div key={star} className="flex items-center gap-2">
                          <span className="text-xs text-gray-500 w-4">{star}★</span>
                          <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-yellow-400 to-amber-500 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-gray-400 w-7">{pct}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Form đánh giá — chỉ mở khoá sau khi hoàn thành tour */}
              {status === 'completed' ? (
                <TourReviewForm
                  tourId={tour.id}
                  existing={myReview ? { rating: myReview.rating, text: myReview.text } : undefined}
                  onSubmitted={(updated) => setTour(updated)}
                />
              ) : (
                <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 p-4 text-center text-sm text-gray-500">
                  🚶 Hoàn thành tour để viết đánh giá của bạn.
                </div>
              )}
              {/* Reviews list */}
              {tour.reviews.map((rv, idx) => (
                <div key={`${rv.name}-${idx}`} className="bg-gray-50 border border-gray-100 rounded-2xl p-4">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-sky-400 to-violet-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                      {rv.avatar}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-bold text-gray-800 text-sm">{rv.name}</p>
                        <Stars rating={rv.rating} size="sm" />
                      </div>
                      <p className="text-xs text-gray-400">{rv.date}</p>
                    </div>
                  </div>
                  <p className="text-sm text-gray-600 leading-relaxed">&ldquo;{rv.text}&rdquo;</p>
                  <p className="text-xs text-gray-400 mt-2">👍 {rv.helpful} người thấy hữu ích</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Footer CTA ── */}
        <div className="p-4 border-t border-gray-100 flex flex-col gap-3 flex-shrink-0">
          {/* Vòng đời tour: bắt đầu đi → đang đi → đã hoàn thành */}
          {status === 'completed' ? (
            <div className="flex items-center justify-center gap-1.5 py-2.5 rounded-2xl bg-emerald-50 border border-emerald-100 text-emerald-700 font-bold text-sm">
              ✓ Đã hoàn thành tour này
            </div>
          ) : status === 'going' ? (
            <div className="flex gap-2">
              <span className="flex-1 flex items-center justify-center gap-1.5 py-3 rounded-2xl bg-sky-50 border border-sky-100 text-sky-700 font-bold text-sm">
                🚶 Đang đi
              </span>
              <button
                onClick={markCompleted}
                className="flex-1 py-3 rounded-2xl bg-emerald-500 text-white font-bold text-sm hover:bg-emerald-600 transition-all active:scale-[0.99]"
              >
                Đã đi xong
              </button>
            </div>
          ) : (
            <button
              onClick={startNavigation}
              className="w-full py-3 rounded-2xl bg-gradient-to-r from-emerald-500 to-sky-500 text-white font-bold text-sm hover:shadow-lg hover:shadow-emerald-500/25 transition-all active:scale-[0.99]"
            >
              ▶ Bắt đầu đi
            </button>
          )}

          <div className="flex gap-3">
            <Link
              href="/ai-chat"
              className="flex-1 py-3.5 bg-gradient-to-r from-sky-500 to-violet-500 text-white rounded-2xl font-bold text-sm text-center hover:shadow-lg hover:shadow-sky-500/25 transition-all hover:scale-[1.01] active:scale-100"
            >
              🤖 Tạo hành trình tương tự với AI
            </Link>
            <button
              onClick={onClose}
              className="px-5 py-3.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-2xl font-semibold text-sm transition-all"
            >
              Đóng
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
