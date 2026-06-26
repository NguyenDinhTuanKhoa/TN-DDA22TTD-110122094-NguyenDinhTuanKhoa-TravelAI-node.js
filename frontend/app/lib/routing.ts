// Orchestrator định tuyến — THUẦN KEYLESS, không cần đăng ký API key nào. Cả 2
// nấc đều dựa trên thuật toán tránh biên giới quốc gia (như Google Maps) để
// tuyến nội địa không cắt thẳng qua Lào/Campuchia:
//   1) Valhalla (FOSSGIS public) — costing 'auto' với country_crossing_penalty
//      cực cao. Mô phỏng đúng cơ chế "phạt nặng khi băng biên giới" của Google
//      Maps: tuyến nội địa luôn rẻ hơn nên không bao giờ đi tắt qua nước khác.
//   2) OSRM (osrm.ts) — cứu cánh cuối khi Valhalla lỗi mạng; KHÔNG biết biên
//      giới (hiếm khi chạm tới).

import {
  type LatLng,
  type Route,
  type RouteStep,
  maneuverToVi,
  fetchRouteOSRM,
  ROUTE_TIMEOUT_MS,
} from './osrm';

// ── Valhalla (FOSSGIS public, KHÔNG cần key) — phạt nặng băng biên giới ───────
const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de/route';

// Chi phí phụ (giây) cho MỖI lần băng qua biên giới quốc gia. Đặt cực cao để
// tuyến nội địa luôn rẻ hơn dù phải đi vòng — gần như "cấm" đi tắt qua nước
// khác, đúng kiểu Google Maps. Dùng `penalty` (KHÔNG phải `cost`) để không thổi
// phồng ETA: nếu tour thật sự sang Lào/Campuchia thì vẫn định tuyến được, thời
// gian hiển thị không bị cộng oan.
const COUNTRY_CROSSING_PENALTY = 50000;

// Map maneuver enum (số) của Valhalla → {type, modifier} kiểu OSRM, để tái dùng
// maneuverToVi. Tham chiếu: Valhalla TripLeg maneuver "type".
const VALHALLA_MANEUVER: Record<number, { type: string; modifier?: string }> = {
  1: { type: 'depart' }, 2: { type: 'depart' }, 3: { type: 'depart' },
  4: { type: 'arrive' }, 5: { type: 'arrive' }, 6: { type: 'arrive' },
  7: { type: 'new name' },                          // becomes (đổi tên đường)
  8: { type: 'continue', modifier: 'straight' },
  9: { type: 'turn', modifier: 'slight right' },
  10: { type: 'turn', modifier: 'right' },
  11: { type: 'turn', modifier: 'sharp right' },
  12: { type: 'turn', modifier: 'uturn' },
  13: { type: 'turn', modifier: 'uturn' },
  14: { type: 'turn', modifier: 'sharp left' },
  15: { type: 'turn', modifier: 'left' },
  16: { type: 'turn', modifier: 'slight left' },
  17: { type: 'on ramp', modifier: 'straight' },
  18: { type: 'on ramp', modifier: 'right' },
  19: { type: 'on ramp', modifier: 'left' },
  20: { type: 'off ramp', modifier: 'right' },
  21: { type: 'off ramp', modifier: 'left' },
  22: { type: 'fork', modifier: 'straight' },       // stay straight
  23: { type: 'fork', modifier: 'right' },          // stay right
  24: { type: 'fork', modifier: 'left' },           // stay left
  25: { type: 'merge' },
  26: { type: 'roundabout' },                       // vào vòng xuyến
  27: { type: 'roundabout' },                       // ra vòng xuyến
  28: { type: 'ferry' },                            // lên phà
  29: { type: 'ferry exit' },                       // rời phà
  37: { type: 'merge', modifier: 'right' },
  38: { type: 'merge', modifier: 'left' },
};

// Giải mã polyline mã hoá của Valhalla — thuật toán Google nhưng precision 1e6.
function decodePolyline6(encoded: string): LatLng[] {
  const coords: LatLng[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let result = 0, shift = 0, b: number;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return coords;
}

// Trả về null nếu lỗi mạng / không có tuyến → caller fallback OSRM.
async function fetchRouteValhalla(points: LatLng[]): Promise<Route | null> {
  if (points.length < 2) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res = await fetch(VALHALLA_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        // Valhalla nhận {lat, lon}.
        locations: points.map((p) => ({ lat: p.lat, lon: p.lng })),
        costing: 'auto',
        costing_options: { auto: { country_crossing_penalty: COUNTRY_CROSSING_PENALTY } },
        directions_options: { units: 'kilometers' },
      }),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const trip = data.trip;
    if (!trip || trip.status !== 0 || !trip.legs?.length) return null;

    const geometry: LatLng[] = [];
    const steps: RouteStep[] = [];

    // Mỗi leg có shape (polyline) + maneuvers riêng; begin_shape_index của
    // maneuver là chỉ số TRONG leg → cộng offset để quy về geometry tổng. Không
    // khử điểm trùng ở ranh giới leg (1 điểm lặp vô hại cho polyline & đo lệch).
    const legs = trip.legs;
    for (let li = 0; li < legs.length; li++) {
      const leg = legs[li];
      const isLastLeg = li === legs.length - 1;
      const offset = geometry.length;
      const legShape = decodePolyline6(leg.shape ?? '');
      for (const c of legShape) geometry.push(c);

      for (const m of leg.maneuvers ?? []) {
        const mapped = VALHALLA_MANEUVER[m.type as number] ?? { type: '' };
        // Trạm trung gian: Valhalla kết thúc mỗi leg bằng maneuver 'arrive' → hạ
        // xuống 'waypoint' để không phát "Đã đến nơi" giả ở trạm chưa phải đích.
        const type = (mapped.type === 'arrive' && !isLastLeg) ? 'waypoint' : mapped.type;
        const road = m.street_names?.[0] ?? '';
        const gi = offset + (m.begin_shape_index ?? 0);
        steps.push({
          text: maneuverToVi(type, mapped.modifier, road, m.roundabout_exit_count),
          name: road,
          distance: (m.length ?? 0) * 1000,   // km → m
          duration: m.time ?? 0,
          type,
          modifier: mapped.modifier,
          location: geometry[gi] ?? { lat: 0, lng: 0 },
        });
      }
    }

    // Valhalla báo OK nhưng shape rỗng (bất thường) → coi như thất bại để
    // fetchRoute còn fallback OSRM, thay vì trả Route rỗng làm kẹt UI.
    if (geometry.length < 2) return null;

    const summary = trip.summary ?? {};
    return {
      geometry,
      steps,
      distance: (summary.length ?? 0) * 1000,  // km → m
      duration: summary.time ?? 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Hàm dẫn đường chính cho UI ───────────────────────────────────────────────
// Thuần keyless, 2 nấc (xem comment đầu file). Signature giữ nguyên.
export async function fetchRoute(points: LatLng[]): Promise<Route | null> {
  const valhalla = await fetchRouteValhalla(points); // 1) keyless, phạt biên giới
  if (valhalla) return valhalla;
  return fetchRouteOSRM(points);                     // 2) cứu cánh, có thể xuyên biên
}
