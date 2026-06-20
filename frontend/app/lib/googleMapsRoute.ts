// Dựng URL Google Maps từ danh sách trạm đã chuẩn hoá (`NavWaypoint`).
//
// Port từ logic cũ trong LiveMapPanel (itinerary/[id]/page.tsx) nhưng làm việc
// trực tiếp trên `lat`/`lng` của NavWaypoint thay vì `location.coordinates`, để
// trang /navigate dùng chung cho cả lịch trình lẫn tour.
import type { NavWaypoint } from '../components/LiveNavigation';

// Google Maps web hỗ trợ tối đa ~10 điểm trong URL chỉ đường.
export const GOOGLE_MAPS_MAX_STOPS = 10;

function hasCoords(wp: NavWaypoint): boolean {
  return (
    wp?.lat != null &&
    wp?.lng != null &&
    !Number.isNaN(wp.lat) &&
    !Number.isNaN(wp.lng)
  );
}

function searchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// Link Google Maps search cho 1 trạm (ưu tiên toạ độ, fallback tên + thành phố).
export function buildStopSearchUrl(wp: NavWaypoint): string {
  if (hasCoords(wp)) return searchUrl(`${wp.lat},${wp.lng}`);
  return searchUrl(`${wp.name || ''} ${wp.city || ''} Vietnam`.trim());
}

// Dựng URL chỉ đường (origin / destination / waypoints). Khi > 10 trạm thì sample
// đều (giữ điểm đầu + cuối). Khi 0–1 trạm hợp lệ thì fallback về search.
export function buildGoogleMapsUrl(waypoints: NavWaypoint[]): string {
  if (!waypoints || waypoints.length === 0) return 'https://maps.google.com';

  const valid = waypoints.filter(hasCoords);

  if (valid.length === 0) {
    const first = waypoints[0];
    return searchUrl(`${first?.name || ''} ${first?.city || ''} Vietnam`.trim());
  }

  if (valid.length === 1) {
    const d = valid[0];
    return searchUrl(`${d.lat},${d.lng}`);
  }

  // Quá 10 điểm → sample đều, luôn giữ điểm đầu và điểm cuối.
  let selected = valid;
  if (valid.length > GOOGLE_MAPS_MAX_STOPS) {
    selected = [valid[0]];
    const step = (valid.length - 1) / (GOOGLE_MAPS_MAX_STOPS - 1);
    for (let i = 1; i < GOOGLE_MAPS_MAX_STOPS - 1; i++) {
      selected.push(valid[Math.round(i * step)]);
    }
    selected.push(valid[valid.length - 1]);
  }

  const origin = `${selected[0].lat},${selected[0].lng}`;
  const destination = `${selected[selected.length - 1].lat},${selected[selected.length - 1].lng}`;
  const mid = selected.slice(1, -1).map((d) => `${d.lat},${d.lng}`);

  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
  if (mid.length > 0) url += `&waypoints=${mid.join('|')}`;
  return url;
}

// Chia hành trình dài thành các chặng ~6 trạm (overlap 1 trạm) để mở từng phần
// trên Google Maps — vì URL chỉ đường giới hạn ~10 điểm.
export function buildSegmentUrls(waypoints: NavWaypoint[]): { label: string; url: string }[] {
  if (!waypoints || waypoints.length <= GOOGLE_MAPS_MAX_STOPS) return [];
  const segmentSize = 6;
  const segments: { label: string; url: string }[] = [];
  for (let i = 0; i < waypoints.length; i += segmentSize - 1) {
    const chunk = waypoints.slice(i, Math.min(i + segmentSize, waypoints.length));
    if (chunk.length < 2) break;
    const from = chunk[0].name || `Trạm ${i + 1}`;
    const to = chunk[chunk.length - 1].name || `Trạm ${i + chunk.length}`;
    segments.push({ label: `${from} → ${to}`, url: buildGoogleMapsUrl(chunk) });
  }
  return segments;
}
