// Định tuyến theo đường phố thật qua OSRM (Open Source Routing Machine) — dịch vụ
// public miễn phí, không cần API key. Cùng tinh thần "xài dịch vụ OSM free" như
// geocode.ts (Nominatim). Dùng cho chế độ dẫn đường thực tế (turn-by-turn) ở
// trang lịch trình và tour cộng đồng.

export interface LatLng { lat: number; lng: number }

// Một bước chỉ dẫn (maneuver) đã chuẩn hoá cho UI.
export interface RouteStep {
  text: string;            // câu chỉ dẫn tiếng Việt: "Rẽ phải vào Trần Phú"
  name: string;            // tên đường của bước (có thể rỗng)
  distance: number;        // mét — độ dài đoạn dẫn tới maneuver kế tiếp
  duration: number;        // giây
  type: string;            // maneuver type gốc của OSRM (turn, arrive, ...)
  modifier?: string;       // hướng: left/right/straight/...
  location: LatLng;        // toạ độ điểm xảy ra maneuver
}

export interface Route {
  geometry: LatLng[];      // đường đi chi tiết theo phố (để vẽ polyline)
  steps: RouteStep[];      // danh sách chỉ dẫn turn-by-turn
  distance: number;        // tổng mét
  duration: number;        // tổng giây
}

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';

// Timeout cứng cho mọi lời gọi routing — server demo công cộng có thể "treo"
// (TCP nối nhưng không trả lời) mà fetch của trình duyệt KHÔNG tự timeout, sẽ
// làm cả UI dẫn đường đơ vĩnh viễn. Hết hạn → abort → trả null → caller
// fallback sang nhà cung cấp khác hoặc báo lỗi.
export const ROUTE_TIMEOUT_MS = 12000;

// ── Dịch maneuver của OSRM sang câu tiếng Việt ──────────────────────────────
// Tham chiếu: https://github.com/Project-OSRM/osrm-text-instructions
const MODIFIER_VI: Record<string, string> = {
  'left': 'rẽ trái',
  'right': 'rẽ phải',
  'sharp left': 'rẽ gắt sang trái',
  'sharp right': 'rẽ gắt sang phải',
  'slight left': 'chếch sang trái',
  'slight right': 'chếch sang phải',
  'straight': 'đi thẳng',
  'uturn': 'quay đầu',
};

export function maneuverToVi(
  type: string,
  modifier: string | undefined,
  roadName: string,
  exit?: number
): string {
  const road = roadName ? ` vào ${roadName}` : '';
  const dir = modifier ? MODIFIER_VI[modifier] : undefined;

  switch (type) {
    case 'depart':
      return roadName ? `Xuất phát trên ${roadName}` : 'Bắt đầu hành trình';
    case 'arrive':
      return 'Đã đến nơi 🏁';
    case 'turn':
    case 'end of road':
    case 'new name':
      if (modifier === 'straight') return `Đi thẳng${road}`;
      return dir ? `${cap(dir)}${road}` : `Tiếp tục${road}`;
    case 'merge':
      return `Nhập làn${road}`;
    case 'on ramp':
      return `Vào đường nhánh${road}`;
    case 'off ramp':
      return `Ra khỏi đường nhánh${road}`;
    case 'fork':
      return dir ? `Tại ngã rẽ, ${dir}${road}` : `Tại ngã rẽ, tiếp tục${road}`;
    case 'roundabout':
    case 'rotary':
      return exit
        ? `Vào vòng xuyến, ra lối thứ ${exit}${road}`
        : `Đi theo vòng xuyến${road}`;
    case 'continue':
      return dir && modifier !== 'straight' ? `${cap(dir)}${road}` : `Tiếp tục đi thẳng${road}`;
    case 'ferry':
      return roadName ? `Lên phà ${roadName}` : 'Lên phà';
    case 'ferry exit':
      return 'Rời phà, đi tiếp';
    case 'waypoint':
      return 'Đã tới trạm dừng';
    default:
      return dir ? `${cap(dir)}${road}` : `Tiếp tục${road}`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Gọi OSRM để lấy tuyến qua danh sách điểm (đã có toạ độ) ───────────────────
// Trả về null nếu lỗi mạng / không có tuyến → caller tự fallback.
// CẢNH BÁO: OSRM demo không biết biên giới quốc gia → tuyến có thể cắt qua
// Lào/Campuchia. Dùng làm fallback cho ORS (xem routing.ts).
export async function fetchRouteOSRM(points: LatLng[]): Promise<Route | null> {
  if (points.length < 2) return null;

  // OSRM nhận lng,lat (ngược với thường lệ).
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const url =
    `${OSRM_BASE}/${coords}` +
    `?overview=full&geometries=geojson&steps=true&annotations=false`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.[0]) return null;

    const route = data.routes[0];

    // Geometry tổng của tuyến (GeoJSON: [lng, lat]).
    const geometry: LatLng[] = (route.geometry?.coordinates ?? []).map(
      ([lng, lat]: [number, number]) => ({ lat, lng })
    );

    // Gom step từ mọi leg thành danh sách phẳng. OSRM kết thúc MỖI leg bằng
    // 'arrive'; với tuyến nhiều trạm, các 'arrive' ở leg chưa-phải-cuối được hạ
    // xuống 'waypoint' để không phát "Đã đến nơi" giả tại trạm trung gian.
    const steps: RouteStep[] = [];
    const legs = route.legs ?? [];
    for (let li = 0; li < legs.length; li++) {
      const isLastLeg = li === legs.length - 1;
      for (const s of legs[li].steps ?? []) {
        const m = s.maneuver ?? {};
        const [mLng, mLat] = m.location ?? [0, 0];
        const type = (m.type === 'arrive' && !isLastLeg) ? 'waypoint' : (m.type ?? '');
        steps.push({
          text: maneuverToVi(type, m.modifier, s.name || '', m.exit),
          name: s.name || '',
          distance: s.distance ?? 0,
          duration: s.duration ?? 0,
          type,
          modifier: m.modifier,
          location: { lat: mLat, lng: mLng },
        });
      }
    }

    return {
      geometry,
      steps,
      distance: route.distance ?? 0,
      duration: route.duration ?? 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Tiện ích định dạng cho UI ───────────────────────────────────────────────
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} phút`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h${m}` : `${h}h`;
}

// Khoảng cách Haversine (mét) giữa 2 toạ độ — để đếm ngược tới maneuver,
// phát hiện lệch tuyến, và đo tiến độ. Bản mét, tách riêng khỏi haversine(km)
// dùng ở trang lịch trình.
export function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Khoảng cách từ điểm p tới đoạn thẳng a→b (mét) — xấp xỉ phẳng, đủ chính xác
// ở quy mô vài km để biết người dùng còn bám tuyến hay đã lệch.
export function distanceToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  // Quy đổi sang mặt phẳng địa phương (mét) quanh điểm a.
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((a.lat * Math.PI) / 180);
  const ax = 0, ay = 0;
  const bx = (b.lng - a.lng) * mPerDegLng;
  const by = (b.lat - a.lat) * mPerDegLat;
  const px = (p.lng - a.lng) * mPerDegLng;
  const py = (p.lat - a.lat) * mPerDegLat;

  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Khoảng cách ngắn nhất từ p tới toàn bộ polyline tuyến (mét).
export function distanceToRoute(p: LatLng, geometry: LatLng[]): number {
  if (geometry.length === 0) return Infinity;
  if (geometry.length === 1) return haversineMeters(p, geometry[0]);
  let min = Infinity;
  for (let i = 0; i < geometry.length - 1; i++) {
    const d = distanceToSegment(p, geometry[i], geometry[i + 1]);
    if (d < min) min = d;
  }
  return min;
}
