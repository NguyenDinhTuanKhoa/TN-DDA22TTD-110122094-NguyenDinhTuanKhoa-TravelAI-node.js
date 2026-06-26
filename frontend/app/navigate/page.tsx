'use client';
import { useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { loadNavPayload, NAV_STORAGE_KEY, type NavPayload } from '../lib/navHandoff';
import { setTourStatus } from '../lib/tourProgress';
import TourReviewForm from '../components/TourReviewForm';

// Bản đồ dẫn đường thực tế (turn-by-turn) — client-only vì cần GPS + window.
// Tự chiếm trọn màn hình (absolute inset-0) + bottom sheet riêng, giống Google Maps.
const LiveNavigation = dynamic(() => import('../components/LiveNavigation'), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-sky-50 to-blue-50 text-sm text-gray-400">
      Đang tải bản đồ dẫn đường…
    </div>
  ),
});

// Đọc payload từ sessionStorage như một external store. useSyncExternalStore trả
// server snapshot = null (SSR an toàn) và client snapshot từ sessionStorage — đúng
// chuẩn React cho dữ liệu client-only, tránh hydration mismatch lẫn cảnh báo
// set-state-in-effect. Cache theo chuỗi raw để getSnapshot trả về ref ổn định.
const subscribeNoop = () => () => {};
let cachedRaw: string | null | undefined;
let cachedPayload: NavPayload | null = null;
function getClientPayload(): NavPayload | null {
  const raw = window.sessionStorage.getItem(NAV_STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPayload = loadNavPayload();
  }
  return cachedPayload;
}
const getServerPayload = (): NavPayload | null => null;

export default function NavigatePage() {
  const router = useRouter();
  const payload = useSyncExternalStore(subscribeNoop, getClientPayload, getServerPayload);
  const [arrived, setArrived] = useState(false);   // tới đích → overlay hoàn thành
  const [reviewed, setReviewed] = useState(false);  // đã gửi đánh giá trong overlay

  // Không có dữ liệu (vào thẳng /navigate) → empty state + đường quay lại.
  if (!payload || payload.waypoints.length === 0) {
    return (
      <div className="h-[100dvh] flex flex-col items-center justify-center gap-4 bg-gray-50 text-center px-6">
        <div className="text-5xl">🧭</div>
        <h1 className="text-lg font-bold text-gray-700">Không có dữ liệu dẫn đường</h1>
        <p className="text-sm text-gray-400 max-w-xs">
          Hãy mở từ một lịch trình hoặc tour rồi bấm <b>“Dẫn đường”</b> để bắt đầu.
        </p>
        <Link
          href="/itinerary"
          className="mt-2 px-5 py-2.5 bg-sky-600 text-white font-bold rounded-xl text-sm hover:bg-sky-700 transition-colors"
        >
          ← Về lịch trình của tôi
        </Link>
      </div>
    );
  }

  const { title, waypoints, tourId } = payload;

  return (
    <div className="fixed inset-0 bg-gray-100">
      {/* ── App bar nổi: nút quay lại + tiêu đề (giống Google Maps) ── */}
      <div className="absolute top-0 inset-x-0 z-[700] flex items-center gap-2.5 px-3 pt-3 pointer-events-none">
        <button
          onClick={() => router.back()}
          className="pointer-events-auto w-11 h-11 rounded-full bg-white shadow-lg flex items-center justify-center text-gray-700 hover:scale-105 active:scale-95 transition-transform shrink-0"
          title="Quay lại"
          aria-label="Quay lại"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="pointer-events-auto min-w-0 flex-1 max-w-2xl bg-white/95 backdrop-blur rounded-2xl shadow-lg px-4 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-sky-600 leading-none">🧭 Dẫn đường</p>
          <h1 className="font-black text-gray-800 text-sm truncate leading-tight mt-0.5">{title || 'Lộ trình của bạn'}</h1>
        </div>
      </div>

      {/* Bản đồ full-screen + bottom sheet do LiveNavigation tự render */}
      <LiveNavigation
        title={title}
        waypoints={waypoints}
        onArrive={() => {
          if (!tourId) return;            // chỉ tour đã lưu mới có vòng đời + đánh giá
          setTourStatus(tourId, 'completed');
          setArrived(true);
        }}
      />

      {/* ── Overlay hoàn thành tour: mời đánh giá ngay tại chỗ ── */}
      {arrived && tourId && (
        <div className="absolute inset-0 z-[900] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl p-6 max-h-[90vh] overflow-y-auto">
            <div className="text-center mb-4">
              <div className="text-5xl mb-2">🎉</div>
              <h2 className="text-xl font-black text-gray-900">Hoàn thành tour!</h2>
              <p className="text-sm text-gray-500 mt-1">
                {title ? `Bạn đã đi xong “${title}”.` : 'Bạn đã tới đích.'} Chia sẻ cảm nhận nhé.
              </p>
            </div>

            {reviewed ? (
              <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4 text-center text-sm font-semibold text-emerald-700">
                ✓ Cảm ơn đánh giá của bạn!
              </div>
            ) : (
              <TourReviewForm tourId={tourId} onSubmitted={() => setReviewed(true)} />
            )}

            <div className="mt-4 flex gap-2">
              <Link
                href="/saved"
                className="flex-1 text-center py-3 rounded-2xl bg-sky-500 text-white font-bold text-sm hover:bg-sky-600 transition-all"
              >
                Về tour đã lưu
              </Link>
              <button
                onClick={() => setArrived(false)}
                className="px-4 py-3 rounded-2xl bg-gray-100 text-gray-600 font-semibold text-sm hover:bg-gray-200 transition-all"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
