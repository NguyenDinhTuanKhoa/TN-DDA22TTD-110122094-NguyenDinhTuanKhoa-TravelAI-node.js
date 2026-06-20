'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { loadNavPayload, NAV_STORAGE_KEY, type NavPayload } from '../lib/navHandoff';
import {
  buildGoogleMapsUrl,
  buildSegmentUrls,
  buildStopSearchUrl,
  GOOGLE_MAPS_MAX_STOPS,
} from '../lib/googleMapsRoute';
import { haversineMeters, formatDistance } from '../lib/osrm';
import type { NavWaypoint } from '../components/LiveNavigation';

// Bản đồ dẫn đường thực tế (turn-by-turn) — client-only vì cần GPS + window.
const LiveNavigation = dynamic(() => import('../components/LiveNavigation'), {
  ssr: false,
  loading: () => (
    <div className="h-[60vh] rounded-2xl bg-gradient-to-br from-sky-50 to-blue-50 border border-sky-100 flex items-center justify-center text-sm text-gray-400">
      Đang tải bản đồ dẫn đường…
    </div>
  ),
});

// Khoảng cách tới trạm kế tiếp (chuỗi đã format) — null nếu thiếu toạ độ.
function distToNext(a: NavWaypoint, b?: NavWaypoint): string | null {
  if (!b) return null;
  if (a?.lat == null || a?.lng == null || b?.lat == null || b?.lng == null) return null;
  return formatDistance(haversineMeters({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }));
}

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
  // Bản đồ cao gần trọn màn hình đầu; phần còn lại (Google Maps, lộ trình) cuộn xuống.
  const [mapHeight, setMapHeight] = useState(460);

  useEffect(() => {
    const update = () => setMapHeight(Math.max(360, window.innerHeight - 280));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

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

  const { title, waypoints } = payload;
  const estimatedHours = Math.round(waypoints.length * 0.5 * 10) / 10;
  const segmentUrls = buildSegmentUrls(waypoints);
  const isTruncated = waypoints.length > GOOGLE_MAPS_MAX_STOPS;

  return (
    <div className="h-[100dvh] flex flex-col bg-gray-50">
      {/* ── Header ── */}
      <header className="sticky top-0 z-[700] flex items-center gap-3 px-4 h-14 bg-white/90 backdrop-blur border-b border-gray-100 shrink-0">
        <button
          onClick={() => router.back()}
          className="w-9 h-9 rounded-full flex items-center justify-center text-gray-600 hover:bg-gray-100 transition-colors shrink-0"
          title="Quay lại"
          aria-label="Quay lại"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-600">🧭 Dẫn đường</p>
          <h1 className="font-black text-gray-800 leading-tight truncate">{title || 'Lộ trình của bạn'}</h1>
        </div>
      </header>

      {/* ── Nội dung ── */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-4 space-y-4">
          {/* Bản đồ turn-by-turn thật (GPS + giọng nói) */}
          <LiveNavigation title={title} height={mapHeight} waypoints={waypoints} />

          {/* Card fallback — mở bằng app Google Maps */}
          <div className="bg-gradient-to-r from-blue-600 to-sky-500 rounded-3xl p-5 text-white shadow-xl shadow-blue-500/20">
            <div className="flex items-start justify-between mb-4">
              <div>
                <p className="text-blue-100 text-xs font-semibold uppercase tracking-wider mb-1">📲 Hoặc mở bằng Google Maps</p>
                <h3 className="text-xl font-black">{title || 'Lộ trình của bạn'}</h3>
              </div>
              <div className="bg-white/20 rounded-2xl px-3 py-2 text-center backdrop-blur-sm">
                <p className="text-2xl font-black">{waypoints.length}</p>
                <p className="text-blue-100 text-xs">trạm</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="bg-white/15 rounded-2xl px-4 py-3 backdrop-blur-sm">
                <p className="text-blue-100 text-xs mb-0.5">⏱️ Ước tính di chuyển</p>
                <p className="font-bold text-sm">~{estimatedHours}h (không dừng)</p>
              </div>
              <div className="bg-white/15 rounded-2xl px-4 py-3 backdrop-blur-sm">
                <p className="text-blue-100 text-xs mb-0.5">🚗 Phương tiện</p>
                <p className="font-bold text-sm">Xe máy / Ô tô</p>
              </div>
            </div>

            <a
              href={buildGoogleMapsUrl(waypoints)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-3 w-full py-4 bg-white rounded-2xl text-blue-600 font-black text-base hover:scale-[1.02] transition-transform shadow-lg active:scale-100"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#4285F4" />
                <path d="M12 11.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="white" />
              </svg>
              Mở Google Maps — Dẫn đường ngay!
            </a>
            <p className="text-center text-blue-100 text-xs mt-2">
              {isTruncated
                ? `Hiển thị ${GOOGLE_MAPS_MAX_STOPS}/${waypoints.length} trạm chính trên bản đồ`
                : `Tự động điền ${waypoints.length} trạm dừng trên lộ trình`}
            </p>

            {/* Segment links — khi có quá nhiều trạm */}
            {segmentUrls.length > 0 && (
              <div className="mt-4 space-y-2">
                <p className="text-blue-100 text-xs font-semibold">📋 Xem từng chặng (đầy đủ {waypoints.length} trạm):</p>
                <div className="grid gap-2">
                  {segmentUrls.map((seg, i) => (
                    <a
                      key={i}
                      href={seg.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-4 py-2.5 bg-white/15 hover:bg-white/25 rounded-xl text-sm transition-all border border-white/10"
                    >
                      <span className="bg-white/30 rounded-lg w-7 h-7 flex items-center justify-center text-xs font-black shrink-0">
                        {i + 1}
                      </span>
                      <span className="truncate">{seg.label}</span>
                      <span className="ml-auto text-blue-200 text-xs shrink-0">→ Maps</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Thứ tự lộ trình tối ưu */}
          <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h4 className="font-bold text-gray-800 flex items-center gap-2">📍 Thứ tự lộ trình</h4>
              <span className="text-xs bg-green-100 text-green-700 font-semibold px-2.5 py-1 rounded-xl">{waypoints.length} trạm</span>
            </div>
            <div className="divide-y divide-gray-50">
              {waypoints.map((wp, idx) => {
                const isFirst = idx === 0;
                const isLast = idx === waypoints.length - 1;
                const next = distToNext(wp, waypoints[idx + 1]);

                return (
                  <div key={idx}>
                    <div className="flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors group">
                      <div className="flex flex-col items-center shrink-0">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center font-black text-sm shadow-md ${
                          isFirst ? 'bg-green-400 text-white' :
                          isLast ? 'bg-red-400 text-white' :
                          'bg-gradient-to-br from-sky-400 to-blue-600 text-white'
                        }`}>
                          {isFirst ? '🚀' : isLast ? '🏁' : idx + 1}
                        </div>
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-gray-900 truncate">{wp.name}</p>
                        <p className="text-xs text-gray-400 truncate">
                          {isFirst ? '🟢 Điểm xuất phát' : isLast ? '🔴 Điểm kết thúc' : `Trạm dừng ${idx + 1}`}
                          {wp.city && ` · ${wp.city}`}
                        </p>
                      </div>

                      <a
                        href={buildStopSearchUrl(wp)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 px-3 py-1.5 bg-sky-50 hover:bg-sky-100 text-sky-600 text-xs font-semibold rounded-xl transition-all opacity-0 group-hover:opacity-100"
                      >
                        Xem 📍
                      </a>
                    </div>

                    {!isLast && next && (
                      <div className="flex items-center gap-3 pl-[2.75rem] pr-5 py-1">
                        <div className="w-0.5 h-4 bg-gray-200 mx-4 shrink-0" />
                        <span className="text-xs text-gray-400 bg-gray-50 border border-gray-200 rounded-full px-2.5 py-0.5 font-medium">
                          ↓ {next}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tip */}
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
            <span className="text-xl shrink-0">💡</span>
            <p className="text-amber-800 text-xs leading-relaxed">
              <strong>Mẹo:</strong> Cho phép truy cập vị trí để nghe chỉ dẫn giọng nói turn-by-turn ngay trong web. Hoặc bấm nút trắng phía trên để mở app Google Maps trên điện thoại.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
