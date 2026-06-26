'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { geocodeMany } from '../lib/geocode';
import { fetchRoute } from '../lib/routing';
import {
  haversineMeters,
  distanceToRoute,
  formatDistance,
  formatDuration,
  type Route,
  type LatLng,
} from '../lib/osrm';
import {
  buildGoogleMapsUrl,
  buildSegmentUrls,
  buildStopSearchUrl,
  GOOGLE_MAPS_MAX_STOPS,
} from '../lib/googleMapsRoute';

// Điểm dừng đã chuẩn hoá — cả trang lịch trình và tour đều map data của mình
// sang shape này rồi truyền vào. Toạ độ có thể thiếu (tour cộng đồng) → tự geocode.
export interface NavWaypoint {
  name: string;
  city?: string;
  lat?: number;
  lng?: number;
}

interface Props {
  waypoints: NavWaypoint[];
  title?: string;
  // Gọi đúng MỘT lần khi người dùng tới đích cuối (qua GPS thật hoặc demo) — dùng
  // để đánh dấu tour 'completed' & mở lời mời đánh giá. Tour itinerary bỏ trống.
  onArrive?: () => void;
}

const categoryEmoji = { start: '🚩', end: '🏁', mid: '📍' } as const;

// ── Phương tiện (giống Google Maps) ──────────────────────────────────────────
// OSRM public demo chỉ có profile `driving`, nên tuyến đường (geometry) giống
// nhau; sự khác biệt giữa phương tiện được mô hình hoá qua tốc độ trung bình →
// ETA khác nhau, đúng cách Google Maps làm với xe máy ở VN. Khi self-host OSRM
// (lúc xuất app) có thể thay bằng profile riêng cho từng phương tiện.
type VehicleId = 'motorbike' | 'car' | 'coach';

// Icon line-art (stroke) thay cho emoji — đồng bộ nét, sắc trên mọi nền, đổi màu
// theo `currentColor` để bám trạng thái chọn. viewBox 24×24, vẽ ở weight 1.8.
function VehicleIcon({ id, className }: { id: VehicleId; className?: string }) {
  const common = {
    className,
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (id) {
    case 'motorbike':
      return (
        <svg {...common}>
          <circle cx="5.5" cy="17" r="3" />
          <circle cx="18.5" cy="17" r="3" />
          <path d="M8.5 17h6l3-5h-4l-2-3H8" />
          <path d="M14 9h3l1.5 3" />
          <path d="M5.5 17l3-5" />
        </svg>
      );
    case 'car':
      return (
        <svg {...common}>
          <path d="M3 13l1.8-4.2A2 2 0 0 1 6.6 7.6h10.8a2 2 0 0 1 1.8 1.2L21 13" />
          <path d="M3 13h18v4a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-.5h-9V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
          <circle cx="7" cy="15.5" r="1.1" />
          <circle cx="17" cy="15.5" r="1.1" />
        </svg>
      );
    case 'coach':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="13" rx="2" />
          <path d="M4 11h16" />
          <path d="M8 4v7M12 4v7M16 4v7" />
          <path d="M6 17v1.5M18 17v1.5" />
          <circle cx="8" cy="17" r="0.6" />
          <circle cx="16" cy="17" r="0.6" />
        </svg>
      );
  }
}

const VEHICLES: { id: VehicleId; label: string; factor: number }[] = [
  { id: 'motorbike', label: 'Xe máy',  factor: 0.9 },  // luồn lách, nhanh hơn trong phố
  { id: 'car',       label: 'Ô tô',    factor: 1.0 },  // baseline OSRM
  { id: 'coach',     label: 'Xe khách', factor: 1.3 },  // cồng kềnh, dừng đón trả
];

// Biểu tượng hướng cho banner chỉ dẫn — map theo maneuver modifier.
const ARROW: Record<string, string> = {
  left: '↰', right: '↱', 'sharp left': '⮰', 'sharp right': '⮱',
  'slight left': '↖', 'slight right': '↗', straight: '↑', uturn: '⮌',
};

function arrowFor(type: string, modifier?: string): string {
  if (type === 'arrive') return '🏁';
  if (type === 'depart') return '🚩';
  if (type === 'waypoint') return '📍';
  if (type === 'ferry' || type === 'ferry exit') return '⛴️';
  if (type === 'roundabout' || type === 'rotary') return '🔄';
  return (modifier && ARROW[modifier]) || '↑';
}

// Góc phương vị (độ) từ a → b, để xoay mũi tên vị trí người dùng.
function bearing(a: LatLng, b: LatLng): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

type GpsStatus = 'idle' | 'requesting' | 'granted' | 'denied' | 'unsupported';

// Bản đồ dẫn đường thực tế (turn-by-turn) chạy hoàn toàn trong web:
// tự xin quyền vị trí ngay khi mở, bám GPS, vẽ tuyến theo đường phố (OSRM),
// chỉ dẫn từng chặng + giọng nói TTS, tự tính lại tuyến khi đi lệch. Có bộ chọn
// phương tiện (xe máy / ô tô / xe khách) và chế độ "Mô phỏng" để demo khi GPS
// không di chuyển. Render client-only — nhúng qua dynamic import (ssr:false).
export default function LiveNavigation({ waypoints, title, onArrive }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInst = useRef<L.Map | null>(null);
  const userMarker = useRef<L.Marker | null>(null);
  const routeLayer = useRef<L.Polyline | null>(null);

  // Waypoint đã có toạ độ (giữ thứ tự gốc). null = đang geocode.
  const [located, setLocated] = useState<(NavWaypoint & { lat: number; lng: number })[] | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [routeError, setRouteError] = useState(false);

  // Trạng thái dẫn đường
  const [vehicle, setVehicle] = useState<VehicleId>('motorbike');
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('idle');
  const [navigating, setNavigating] = useState(false);
  const [demo, setDemo] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [userPos, setUserPos] = useState<LatLng | null>(null);
  const [heading, setHeading] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const [offRoute, setOffRoute] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);  // bottom sheet mở rộng (xem trạm + Google Maps)

  const watchId = useRef<number | null>(null);
  const demoTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const demoProgress = useRef(0);           // chỉ số geometry trong demo
  const spokenStep = useRef(-1);            // bước đã đọc TTS (chống lặp)
  const lastReroute = useRef(0);            // mốc thời gian re-route gần nhất
  const arrivedFired = useRef(false);       // đã bắn onArrive chưa (chỉ 1 lần/phiên)

  const factor = VEHICLES.find((v) => v.id === vehicle)!.factor;
  const dur = useCallback((seconds: number) => seconds * factor, [factor]);

  // ── 1. Geocode waypoint thiếu toạ độ ──
  useEffect(() => {
    let cancelled = false;
    const ready = waypoints.map((w) =>
      w.lat != null && w.lng != null ? { ...w, lat: w.lat, lng: w.lng } : null
    );
    const needGeo = waypoints
      .map((w, i) => (ready[i] ? null : { ...w, i }))
      .filter((x): x is NavWaypoint & { i: number } => x !== null);

    if (needGeo.length === 0) {
      setLocated(ready.filter((w): w is NavWaypoint & { lat: number; lng: number } => w !== null));
      return;
    }
    setLocated(null);
    (async () => {
      const coords = await geocodeMany(needGeo.map((w) => ({ name: w.name, city: w.city || '' })));
      if (cancelled) return;
      const filled = [...ready];
      needGeo.forEach((w, k) => {
        if (coords[k]) filled[w.i] = { ...waypoints[w.i], lat: coords[k]!.lat, lng: coords[k]!.lng };
      });
      setLocated(filled.filter((w): w is NavWaypoint & { lat: number; lng: number } => w !== null));
    })();
    return () => { cancelled = true; };
  }, [waypoints]);

  // ── 2. Lấy tuyến OSRM khi đã có toạ độ ──
  const loadRoute = useCallback(async (from?: LatLng) => {
    if (!located || located.length < 1) return;
    const pts: LatLng[] = located.map((w) => ({ lat: w.lat, lng: w.lng }));
    // Bắt đầu từ vị trí thật của người dùng (lúc khởi hành hoặc khi re-route).
    if (from) pts.unshift(from);
    if (pts.length < 2) { setRoute(null); return; }
    setRouteError(false);
    const r = await fetchRoute(pts);
    if (r) { setRoute(r); setStepIdx(0); spokenStep.current = -1; }
    else setRouteError(true);
  }, [located]);

  useEffect(() => { loadRoute(); }, [loadRoute]);

  // ── 3. Bám GPS thật (watchPosition) ──
  const startGPS = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsStatus('unsupported');
      return;
    }
    if (watchId.current != null) return; // đã đang theo dõi
    setGpsStatus('requesting');
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsStatus('granted');
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserPos((prev) => {
          if (pos.coords.heading != null && !isNaN(pos.coords.heading)) setHeading(pos.coords.heading);
          else if (prev) setHeading(bearing(prev, p));
          return p;
        });
      },
      (err) => setGpsStatus(err.code === 1 ? 'denied' : 'idle'),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }, []);

  const stopGPS = useCallback(() => {
    if (watchId.current != null) { navigator.geolocation.clearWatch(watchId.current); watchId.current = null; }
  }, []);

  // ── 3b. Tự động xin quyền vị trí NGAY khi mở trang dẫn đường ──
  // Mở tab "Dẫn đường" là lập tức truy cập vị trí thật; người dùng phải cho phép
  // (bật vị trí) thì mới dẫn đường được — giống mở Google Maps.
  useEffect(() => {
    startGPS();
    return () => stopGPS();
  }, [startGPS, stopGPS]);

  // ── 4. Dựng bản đồ Leaflet sau khi có các điểm ──
  useEffect(() => {
    if (!located || located.length === 0 || !mapRef.current || mapInst.current) return;

    const map = L.map(mapRef.current, { zoomControl: false, scrollWheelZoom: true });
    mapInst.current = map;
    // Zoom +/- ở góc dưới-trái để không đụng các card nổi phía trên (giống Google Maps).
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);

    located.forEach((w, idx) => {
      const kind = idx === 0 ? 'start' : idx === located.length - 1 ? 'end' : 'mid';
      const bg = kind === 'start' ? '#22c55e' : kind === 'end' ? '#ef4444' : '#3b82f6';
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:34px;height:34px;border-radius:50%;background:${bg};
          border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.3);
          display:flex;align-items:center;justify-content:center;font-size:15px">
          ${categoryEmoji[kind]}</div>`,
        iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -20],
      });
      L.marker([w.lat, w.lng], { icon }).addTo(map)
        .bindPopup(`<b>${w.name}</b><br/><span style="color:#94a3b8;font-size:12px">${w.city || ''}</span>`);
    });

    const pts: [number, number][] = located.map((w) => [w.lat, w.lng]);
    // Chừa khoảng cho card phương tiện (trên) và bottom sheet (dưới) để marker không bị che.
    map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [40, 130],
      paddingBottomRight: [40, 230],
    });

    return () => { map.remove(); mapInst.current = null; };
  }, [located]);

  // ── 5. Vẽ / cập nhật polyline tuyến đường thật ──
  useEffect(() => {
    const map = mapInst.current;
    if (!map) return;
    routeLayer.current?.remove();
    if (!route || route.geometry.length < 2) { routeLayer.current = null; return; }
    const latlngs = route.geometry.map((p) => [p.lat, p.lng] as [number, number]);
    L.polyline(latlngs, { color: '#1d4ed8', weight: 8, opacity: 0.25 }).addTo(map);
    routeLayer.current = L.polyline(latlngs, { color: '#3b82f6', weight: 5, opacity: 0.95 }).addTo(map);
  }, [route]);

  // ── 6. Marker vị trí người dùng + camera follow ──
  useEffect(() => {
    const map = mapInst.current;
    if (!map || !userPos) return;

    const html = `<div style="position:relative;width:26px;height:26px">
      <div style="position:absolute;inset:0;border-radius:50%;background:#3b82f6;
        border:3px solid white;box-shadow:0 0 0 6px rgba(59,130,246,.25)"></div>
      <div style="position:absolute;left:50%;top:-9px;transform:translateX(-50%) rotate(${heading}deg);
        transform-origin:50% 22px;font-size:16px;line-height:1">▲</div>
    </div>`;
    const icon = L.divIcon({ className: '', html, iconSize: [26, 26], iconAnchor: [13, 13] });

    if (userMarker.current) {
      userMarker.current.setLatLng([userPos.lat, userPos.lng]).setIcon(icon);
    } else {
      userMarker.current = L.marker([userPos.lat, userPos.lng], { icon, zIndexOffset: 1000 }).addTo(map);
    }
    if (navigating) map.setView([userPos.lat, userPos.lng], Math.max(map.getZoom(), 16), { animate: true });
  }, [userPos, heading, navigating]);

  // ── 7. Logic dẫn đường: tiến bước, đếm ngược, TTS, re-route ──
  const speak = useCallback((text: string) => {
    if (!voiceOn || typeof window === 'undefined' || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'vi-VN';
    u.rate = 1.05;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }, [voiceOn]);

  // Bắn onArrive đúng một lần khi tới đích (GPS thật hoặc demo chạy hết tuyến).
  const fireArrive = useCallback(() => {
    if (arrivedFired.current) return;
    arrivedFired.current = true;
    onArrive?.();
  }, [onArrive]);

  useEffect(() => {
    if (!navigating || !userPos || !route || route.steps.length === 0) return;
    const steps = route.steps;
    let idx = stepIdx;

    while (idx < steps.length - 1 && haversineMeters(userPos, steps[idx].location) < 25) {
      idx++;
    }
    if (idx !== stepIdx) setStepIdx(idx);

    const cur = steps[idx];
    const dist = haversineMeters(userPos, cur.location);

    if (spokenStep.current !== idx && (dist < 160 || cur.type === 'arrive')) {
      speak(dist > 40 ? `Sau ${formatDistance(dist)}, ${lower(cur.text)}` : cur.text);
      spokenStep.current = idx;
    }

    // Tới bước cuối (đích) trong ngưỡng ~40m → coi như hoàn thành tour.
    if (idx === steps.length - 1 && cur.type === 'arrive' && dist < 40) fireArrive();

    const dev = distanceToRoute(userPos, route.geometry);
    const drifting = dev > 60;
    setOffRoute(drifting);
    if (drifting && Date.now() - lastReroute.current > 8000) {
      lastReroute.current = Date.now();
      speak('Đang tính lại tuyến đường');
      loadRoute(userPos);
    }
  }, [userPos, navigating, route, stepIdx, speak, loadRoute, fireArrive]);

  // ── 8. Chế độ mô phỏng — di chuyển dọc tuyến để demo (GPS máy tính đứng yên) ──
  const stopDemo = useCallback(() => {
    if (demoTimer.current) { clearInterval(demoTimer.current); demoTimer.current = null; }
  }, []);

  const startDemo = useCallback(() => {
    if (!route || route.geometry.length < 2) return;
    const geo = route.geometry;
    // Bước nhảy tỉ lệ độ dài tuyến: demo luôn xong trong ~vài phút dù tuyến dài
    // (tránh đi từng điểm/700ms khiến tuyến HN–HCM chạy hàng chục phút, tưởng
    // đứng hình). Tuyến ngắn vẫn nhảy 1 điểm như cũ.
    const step = Math.max(1, Math.floor((geo.length - 1) / 240));
    demoProgress.current = 0;
    demoTimer.current = setInterval(() => {
      const i = demoProgress.current;
      if (i >= geo.length - 1) { fireArrive(); stopDemo(); setNavigating(false); setDemo(false); return; }
      const next = Math.min(i + step, geo.length - 1);
      setUserPos(geo[i]);
      setHeading(bearing(geo[i], geo[next]));
      demoProgress.current = next;
    }, 700);
  }, [route, stopDemo, fireArrive]);

  // ── 9. Bắt đầu / dừng dẫn đường ──
  const toggleNav = (useDemo: boolean) => {
    if (navigating) {
      setNavigating(false); setDemo(false); stopDemo();
      if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
      return;
    }
    setNavigating(true);
    setStepIdx(0);
    spokenStep.current = -1;
    arrivedFired.current = false;   // cho phép bắn onArrive lại ở phiên dẫn đường mới
    if (useDemo) {
      setDemo(true);
      startDemo();
    } else {
      // GPS thật: tính tuyến bắt đầu từ vị trí hiện tại của người dùng.
      if (userPos) loadRoute(userPos);
    }
    if (route?.steps[0]) speak(route.steps[0].text);
  };

  // Dọn dẹp TTS khi unmount (GPS đã dọn ở effect 3b)
  useEffect(() => () => {
    stopDemo();
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
  }, [stopDemo]);

  // ── Đưa bản đồ về vị trí của tôi (hoặc khít toàn tuyến nếu chưa có GPS) ──
  const recenter = useCallback(() => {
    const map = mapInst.current;
    if (!map) return;
    if (userPos) {
      map.setView([userPos.lat, userPos.lng], Math.max(map.getZoom(), 16), { animate: true });
    } else if (located && located.length) {
      const pts: [number, number][] = located.map((w) => [w.lat, w.lng]);
      map.fitBounds(L.latLngBounds(pts), {
        paddingTopLeft: [40, 130],
        paddingBottomRight: [40, 230],
      });
    }
  }, [userPos, located]);

  // ── Số liệu còn lại cho banner (đã quy đổi theo phương tiện) ──
  const remaining = (() => {
    if (!route) return null;
    const steps = route.steps;
    let dist = 0, secs = 0;
    for (let i = stepIdx; i < steps.length; i++) { dist += steps[i].distance; secs += steps[i].duration; }
    if (userPos && steps[stepIdx]) dist += haversineMeters(userPos, steps[stepIdx].location);
    return { dist, dur: dur(secs) };
  })();
  const curStep = route?.steps[stepIdx];
  const distToStep = userPos && curStep ? haversineMeters(userPos, curStep.location) : null;
  const gpsReady = gpsStatus === 'granted' && userPos != null;

  // ── Render trạng thái tải ──
  if (!located) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gradient-to-br from-sky-50 to-blue-50">
        <div className="text-3xl animate-bounce">🛰️</div>
        <p className="text-sm font-semibold text-gray-600">Đang định vị các điểm đến…</p>
      </div>
    );
  }
  if (located.length < 2) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gray-50 text-center px-6">
        <div className="text-3xl">🧭</div>
        <p className="text-sm text-gray-400">Cần ít nhất 2 điểm có toạ độ để dẫn đường.</p>
      </div>
    );
  }

  const segmentUrls = buildSegmentUrls(located);
  const isTruncated = located.length > GOOGLE_MAPS_MAX_STOPS;
  const gpsOverlay = gpsStatus === 'denied' || gpsStatus === 'unsupported' || gpsStatus === 'requesting';

  return (
    <div className="absolute inset-0 overflow-hidden bg-gray-100">
      {/* ── Bản đồ nền (toàn màn hình) ── */}
      <div ref={mapRef} className="absolute inset-0" />

      {/* ── Overlay TRÊN: bộ chọn phương tiện / banner chỉ dẫn turn-by-turn ── */}
      <div className="absolute top-0 inset-x-0 z-[600] px-3 pt-16 pointer-events-none">
        <div className="max-w-2xl mx-auto pointer-events-auto">
          {navigating && curStep ? (
            <div className={`rounded-2xl p-4 text-white shadow-xl transition-colors ${offRoute ? 'bg-gradient-to-r from-amber-500 to-orange-600' : 'bg-gradient-to-r from-blue-600 to-sky-500'}`}>
              <div className="flex items-center gap-4">
                <div className="text-4xl font-black w-12 text-center shrink-0">
                  {arrowFor(curStep.type, curStep.modifier)}
                </div>
                <div className="flex-1 min-w-0">
                  {offRoute ? (
                    <p className="font-bold text-sm">Đang tính lại tuyến đường…</p>
                  ) : (
                    <>
                      {distToStep != null && curStep.type !== 'arrive' && (
                        <p className="text-blue-100 text-xs font-semibold">Sau {formatDistance(distToStep)}</p>
                      )}
                      <p className="font-black text-base leading-tight truncate">{curStep.text}</p>
                    </>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl shadow-xl shadow-black/5 p-1 flex gap-1">
              {VEHICLES.map((v) => {
                const active = vehicle === v.id;
                return (
                  <button
                    key={v.id}
                    onClick={() => setVehicle(v.id)}
                    aria-pressed={active}
                    title={v.label}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-bold transition-all ${
                      active
                        ? 'bg-sky-500 text-white shadow-md shadow-sky-500/25'
                        : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    <VehicleIcon id={v.id} />
                    <span className="hidden sm:inline">{v.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Nút nổi bên phải: giọng nói + về vị trí (giống Google Maps) ── */}
      <div className="absolute right-3 bottom-[15.5rem] z-[600] flex flex-col gap-2.5">
        <button
          onClick={() => { setVoiceOn((vo) => !vo); if (voiceOn && typeof window !== 'undefined') window.speechSynthesis?.cancel(); }}
          className="w-11 h-11 rounded-full bg-white shadow-lg flex items-center justify-center text-lg hover:scale-105 active:scale-95 transition-transform"
          title={voiceOn ? 'Tắt giọng nói' : 'Bật giọng nói'}
        >
          {voiceOn ? '🔊' : '🔇'}
        </button>
        <button
          onClick={recenter}
          className="w-11 h-11 rounded-full bg-white shadow-lg flex items-center justify-center text-blue-600 hover:scale-105 active:scale-95 transition-transform"
          title="Về vị trí của tôi"
          aria-label="Về vị trí của tôi"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3.5" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
        </button>
      </div>

      {/* ── Overlay yêu cầu bật vị trí (không che bottom sheet để vẫn bấm Mô phỏng được) ── */}
      {gpsOverlay && (
        <div className="absolute inset-x-0 top-0 bottom-[14rem] z-[630] bg-white/85 backdrop-blur-sm flex flex-col items-center justify-center text-center px-6 gap-3">
          {gpsStatus === 'requesting' ? (
            <>
              <div className="text-4xl animate-pulse">📡</div>
              <p className="font-bold text-gray-700">Đang xin quyền truy cập vị trí…</p>
              <p className="text-xs text-gray-500">Hãy bấm <b>&quot;Cho phép&quot;</b> trên trình duyệt để dẫn đường.</p>
            </>
          ) : gpsStatus === 'unsupported' ? (
            <>
              <div className="text-4xl">🚫</div>
              <p className="font-bold text-gray-700">Thiết bị không hỗ trợ định vị</p>
              <p className="text-xs text-gray-500">Bạn vẫn có thể bấm <b>Mô phỏng</b> để xem thử lộ trình.</p>
            </>
          ) : (
            <>
              <div className="text-4xl">📍</div>
              <p className="font-bold text-gray-700">Cần bật vị trí để dẫn đường</p>
              <p className="text-xs text-gray-500 max-w-xs">
                Bạn đã từ chối quyền vị trí. Hãy bật lại trong cài đặt trình duyệt (biểu tượng 🔒 trên thanh địa chỉ) rồi thử lại.
              </p>
              <button
                onClick={startGPS}
                className="mt-1 px-5 py-2.5 bg-blue-600 text-white font-bold rounded-xl text-sm hover:bg-blue-700 transition-colors"
              >
                🔄 Thử lại bật vị trí
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Bottom sheet (kéo lên xem chi tiết) ── */}
      <div className="absolute inset-x-0 bottom-0 z-[640]">
        <div className="bg-white rounded-t-3xl shadow-[0_-8px_30px_rgba(0,0,0,0.12)] max-w-2xl mx-auto">
          {/* Tay nắm — bấm để mở/đóng phần chi tiết */}
          <button
            onClick={() => setSheetOpen((o) => !o)}
            className="w-full pt-2.5 pb-1 flex flex-col items-center gap-1"
            aria-label={sheetOpen ? 'Thu gọn' : 'Mở rộng'}
          >
            <span className="w-10 h-1.5 rounded-full bg-gray-300" />
          </button>

          {/* Tóm tắt tuyến + nút bắt đầu (luôn hiển thị) */}
          <div className="px-4 pb-4">
            <div className="flex items-end gap-3 mb-3">
              <div className="min-w-0">
                {navigating && remaining ? (
                  <>
                    <p className="text-2xl font-black text-green-600 leading-none">{formatDuration(remaining.dur)}</p>
                    <p className="text-sm text-gray-500 mt-1">
                      Còn {formatDistance(remaining.dist)} · bước {stepIdx + 1}/{route!.steps.length}
                    </p>
                  </>
                ) : route ? (
                  <>
                    <p className="text-2xl font-black text-green-600 leading-none">{formatDuration(dur(route.duration))}</p>
                    <p className="text-sm text-gray-500 mt-1">{formatDistance(route.distance)} · {located.length} trạm</p>
                  </>
                ) : routeError ? (
                  <p className="text-sm font-semibold text-red-500">Không tải được tuyến (kiểm tra mạng).</p>
                ) : (
                  <p className="text-sm text-gray-400">Đang tính tuyến đường…</p>
                )}
              </div>
              <button
                onClick={() => setSheetOpen((o) => !o)}
                className="ml-auto shrink-0 flex items-center gap-1 text-sm font-semibold text-gray-500 hover:text-gray-700"
              >
                Chi tiết
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${sheetOpen ? 'rotate-180' : ''}`}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => toggleNav(false)}
                disabled={!route || !gpsReady}
                className={`flex-1 py-3.5 rounded-2xl font-black text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  navigating && !demo
                    ? 'bg-red-500 text-white hover:bg-red-600'
                    : 'bg-gradient-to-r from-blue-600 to-sky-500 text-white hover:scale-[1.02]'
                }`}
                title={!gpsReady ? 'Cần bật vị trí để dẫn đường bằng GPS thật' : ''}
              >
                {navigating && !demo ? '⏹ Dừng dẫn đường' : gpsReady ? '▶ Bắt đầu' : '📍 Đang chờ vị trí…'}
              </button>
              <button
                onClick={() => toggleNav(true)}
                disabled={!route}
                className={`px-5 py-3.5 rounded-2xl font-bold text-sm border-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  navigating && demo
                    ? 'bg-red-500 text-white border-red-500'
                    : 'bg-white text-blue-600 border-blue-200 hover:border-blue-400'
                }`}
                title="Chạy thử dọc tuyến (khi GPS không di chuyển)"
              >
                {navigating && demo ? '⏹ Dừng' : '🎬 Mô phỏng'}
              </button>
            </div>
          </div>

          {/* Chi tiết — thứ tự trạm + mở Google Maps (cuộn được) */}
          {sheetOpen && (
            <div className="max-h-[48vh] overflow-y-auto px-4 pb-6 space-y-4 border-t border-gray-100 pt-3">
              {/* Thứ tự lộ trình */}
              <div>
                <h4 className="font-bold text-gray-800 text-sm mb-2 flex items-center gap-2">📍 Thứ tự lộ trình</h4>
                <div className="space-y-1">
                  {located.map((wp, idx) => {
                    const isFirst = idx === 0;
                    const isLast = idx === located.length - 1;
                    return (
                      <a
                        key={idx}
                        href={buildStopSearchUrl(wp)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-gray-50 transition-colors group"
                      >
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center font-black text-xs shadow shrink-0 ${
                          isFirst ? 'bg-green-400 text-white' :
                          isLast ? 'bg-red-400 text-white' :
                          'bg-gradient-to-br from-sky-400 to-blue-600 text-white'
                        }`}>
                          {isFirst ? '🚀' : isLast ? '🏁' : idx + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-gray-800 text-sm truncate">{wp.name}</p>
                          <p className="text-xs text-gray-400 truncate">
                            {isFirst ? '🟢 Xuất phát' : isLast ? '🔴 Kết thúc' : `Trạm dừng ${idx + 1}`}
                            {wp.city && ` · ${wp.city}`}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs text-sky-600 font-semibold opacity-0 group-hover:opacity-100">Xem 📍</span>
                      </a>
                    );
                  })}
                </div>
              </div>

              {/* Mở bằng Google Maps */}
              <a
                href={buildGoogleMapsUrl(located)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-3 w-full py-3.5 bg-gradient-to-r from-blue-600 to-sky-500 rounded-2xl text-white font-black text-sm hover:scale-[1.01] transition-transform shadow-lg shadow-blue-500/20"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#fff" />
                  <circle cx="12" cy="9" r="2.5" fill="#2563eb" />
                </svg>
                Mở trên Google Maps
              </a>
              <p className="text-center text-[11px] text-gray-400 -mt-2">
                {isTruncated
                  ? `Hiển thị ${GOOGLE_MAPS_MAX_STOPS}/${located.length} trạm chính trên Google Maps`
                  : `Tự động điền ${located.length} trạm dừng trên lộ trình`}
              </p>

              {/* Mở từng chặng — khi có quá nhiều trạm */}
              {segmentUrls.length > 0 && (
                <div className="space-y-2">
                  <p className="text-gray-500 text-xs font-semibold">📋 Xem từng chặng (đầy đủ {located.length} trạm):</p>
                  <div className="grid gap-2">
                    {segmentUrls.map((seg, i) => (
                      <a
                        key={i}
                        href={seg.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-3 py-2.5 bg-gray-50 hover:bg-gray-100 rounded-xl text-sm transition-colors border border-gray-100"
                      >
                        <span className="bg-sky-100 text-sky-700 rounded-lg w-6 h-6 flex items-center justify-center text-xs font-black shrink-0">{i + 1}</span>
                        <span className="truncate text-gray-700">{seg.label}</span>
                        <span className="ml-auto text-gray-400 text-xs shrink-0">→ Maps</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-2xl px-3 py-2.5">
                <span className="text-lg shrink-0">💡</span>
                <p className="text-amber-800 text-xs leading-relaxed">
                  Trên điện thoại sẽ dùng GPS thật để dẫn đường turn-by-turn. Trên máy tính, bấm <b>Mô phỏng</b> để xem thử lộ trình chạy.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function lower(s: string): string { return s.charAt(0).toLowerCase() + s.slice(1); }
