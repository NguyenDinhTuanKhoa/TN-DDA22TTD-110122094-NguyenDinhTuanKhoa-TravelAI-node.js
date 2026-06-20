'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { geocodeMany } from '../lib/geocode';
import {
  fetchRoute,
  haversineMeters,
  distanceToRoute,
  formatDistance,
  formatDuration,
  type Route,
  type LatLng,
} from '../lib/osrm';

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
  height?: number;
}

const categoryEmoji = { start: '🚩', end: '🏁', mid: '📍' } as const;

// ── Phương tiện (giống Google Maps) ──────────────────────────────────────────
// OSRM public demo chỉ có profile `driving`, nên tuyến đường (geometry) giống
// nhau; sự khác biệt giữa phương tiện được mô hình hoá qua tốc độ trung bình →
// ETA khác nhau, đúng cách Google Maps làm với xe máy ở VN. Khi self-host OSRM
// (lúc xuất app) có thể thay bằng profile riêng cho từng phương tiện.
type VehicleId = 'motorbike' | 'car' | 'coach';
const VEHICLES: { id: VehicleId; icon: string; label: string; factor: number }[] = [
  { id: 'motorbike', icon: '🏍️', label: 'Xe máy',  factor: 0.9 },  // luồn lách, nhanh hơn trong phố
  { id: 'car',       icon: '🚗', label: 'Ô tô',    factor: 1.0 },  // baseline OSRM
  { id: 'coach',     icon: '🚌', label: 'Xe khách', factor: 1.3 },  // cồng kềnh, dừng đón trả
];

// Biểu tượng hướng cho banner chỉ dẫn — map theo maneuver modifier.
const ARROW: Record<string, string> = {
  left: '↰', right: '↱', 'sharp left': '⮰', 'sharp right': '⮱',
  'slight left': '↖', 'slight right': '↗', straight: '↑', uturn: '⮌',
};

function arrowFor(type: string, modifier?: string): string {
  if (type === 'arrive') return '🏁';
  if (type === 'depart') return '🚩';
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
export default function LiveNavigation({ waypoints, title, height = 460 }: Props) {
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

  const watchId = useRef<number | null>(null);
  const demoTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const demoProgress = useRef(0);           // chỉ số geometry trong demo
  const spokenStep = useRef(-1);            // bước đã đọc TTS (chống lặp)
  const lastReroute = useRef(0);            // mốc thời gian re-route gần nhất

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

    const map = L.map(mapRef.current, { zoomControl: true, scrollWheelZoom: true });
    mapInst.current = map;
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
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });

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

    const dev = distanceToRoute(userPos, route.geometry);
    const drifting = dev > 60;
    setOffRoute(drifting);
    if (drifting && Date.now() - lastReroute.current > 8000) {
      lastReroute.current = Date.now();
      speak('Đang tính lại tuyến đường');
      loadRoute(userPos);
    }
  }, [userPos, navigating, route, stepIdx, speak, loadRoute]);

  // ── 8. Chế độ mô phỏng — di chuyển dọc tuyến để demo (GPS máy tính đứng yên) ──
  const stopDemo = useCallback(() => {
    if (demoTimer.current) { clearInterval(demoTimer.current); demoTimer.current = null; }
  }, []);

  const startDemo = useCallback(() => {
    if (!route || route.geometry.length < 2) return;
    demoProgress.current = 0;
    demoTimer.current = setInterval(() => {
      const geo = route.geometry;
      const i = demoProgress.current;
      if (i >= geo.length - 1) { stopDemo(); setNavigating(false); setDemo(false); return; }
      setUserPos(geo[i]);
      setHeading(bearing(geo[i], geo[i + 1]));
      demoProgress.current = i + 1;
    }, 700);
  }, [route, stopDemo]);

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
      <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-gradient-to-br from-sky-50 to-blue-50 border border-sky-100" style={{ height }}>
        <div className="text-3xl animate-bounce">🛰️</div>
        <p className="text-sm font-semibold text-gray-600">Đang định vị các điểm đến…</p>
      </div>
    );
  }
  if (located.length < 2) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl bg-gray-50 border border-gray-100 text-center px-6" style={{ height }}>
        <div className="text-3xl">🧭</div>
        <p className="text-sm text-gray-400">Cần ít nhất 2 điểm có toạ độ để dẫn đường.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* ── Bộ chọn phương tiện (giống Google Maps) ── */}
      <div className="flex bg-gray-100 rounded-2xl p-1 gap-1">
        {VEHICLES.map((v) => (
          <button
            key={v.id}
            onClick={() => setVehicle(v.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-sm font-bold transition-all ${
              vehicle === v.id ? 'bg-white shadow-md text-blue-600' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <span className="text-lg">{v.icon}</span>
            <span className="hidden sm:inline">{v.label}</span>
          </button>
        ))}
      </div>

      {/* ── Banner chỉ dẫn turn-by-turn ── */}
      {navigating && curStep ? (
        <div className={`rounded-2xl p-4 text-white shadow-lg transition-colors ${offRoute ? 'bg-gradient-to-r from-amber-500 to-orange-600' : 'bg-gradient-to-r from-blue-600 to-sky-500'}`}>
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
          {remaining && (
            <div className="flex items-center gap-4 mt-3 pt-3 border-t border-white/20 text-sm">
              <span className="font-bold">🏁 {formatDistance(remaining.dist)}</span>
              <span className="font-bold">⏱️ {formatDuration(remaining.dur)}</span>
              <span className="ml-auto text-blue-100 text-xs">Bước {stepIdx + 1}/{route!.steps.length}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl p-4 bg-gradient-to-r from-blue-600 to-sky-500 text-white shadow-lg">
          <p className="text-blue-100 text-xs font-semibold uppercase tracking-wider mb-0.5">🧭 Dẫn đường thực tế</p>
          <h3 className="font-black text-lg leading-tight">{title || 'Lộ trình của bạn'}</h3>
          {route ? (
            <p className="text-blue-100 text-sm mt-1">
              Tổng {formatDistance(route.distance)} · ~{formatDuration(dur(route.duration))} · {located.length} trạm
            </p>
          ) : routeError ? (
            <p className="text-blue-100 text-sm mt-1">Không tải được tuyến đường (kiểm tra mạng).</p>
          ) : (
            <p className="text-blue-100 text-sm mt-1">Đang tính tuyến đường…</p>
          )}
        </div>
      )}

      {/* ── Bản đồ ── */}
      <div className="rounded-2xl overflow-hidden shadow-xl border border-gray-100 relative">
        <div ref={mapRef} style={{ height, width: '100%' }} />

        {/* Nút bật/tắt giọng nói */}
        <button
          onClick={() => { setVoiceOn((v) => !v); if (voiceOn && typeof window !== 'undefined') window.speechSynthesis?.cancel(); }}
          className="absolute top-3 right-3 z-[500] w-10 h-10 rounded-full bg-white shadow-lg flex items-center justify-center text-lg hover:scale-105 transition-transform"
          title={voiceOn ? 'Tắt giọng nói' : 'Bật giọng nói'}
        >
          {voiceOn ? '🔊' : '🔇'}
        </button>

        {/* Overlay yêu cầu bật vị trí — phải cho phép mới dẫn đường được */}
        {(gpsStatus === 'denied' || gpsStatus === 'unsupported' || gpsStatus === 'requesting') && (
          <div className="absolute inset-0 z-[600] bg-white/85 backdrop-blur-sm flex flex-col items-center justify-center text-center px-6 gap-3">
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
      </div>

      {/* ── Thanh điều khiển ── */}
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
          {navigating && !demo ? '⏹ Dừng dẫn đường' : gpsReady ? '▶ Bắt đầu dẫn đường' : '📍 Đang chờ vị trí…'}
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
      <p className="text-center text-[11px] text-gray-400">
        💡 Trên điện thoại sẽ dùng GPS thật để dẫn đường. Trên máy tính, bấm <b>Mô phỏng</b> để xem thử.
      </p>
    </div>
  );
}

function lower(s: string): string { return s.charAt(0).toLowerCase() + s.slice(1); }
