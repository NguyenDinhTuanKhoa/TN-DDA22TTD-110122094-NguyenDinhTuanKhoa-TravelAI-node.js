// Cầu nối dữ liệu cho trang dẫn đường riêng (/navigate).
//
// Vì có 2 nguồn data khác nhau — lịch trình (load qua API theo id) và tour
// (chỉ nằm trong localStorage, KHÔNG có trong DB) — nên trang /navigate không
// thể reload bằng id chung. Thay vào đó, caller chuẩn hoá data về `NavWaypoint[]`
// rồi stash vào sessionStorage ngay trước khi `router.push('/navigate')`. Trang
// /navigate đọc lại payload này khi mount. sessionStorage sống theo tab nên F5
// vẫn còn data; ta KHÔNG xoá sau khi đọc để giữ được hành vi reload.
import type { NavWaypoint } from '../components/LiveNavigation';

export const NAV_STORAGE_KEY = 'travelai:nav';

export interface NavPayload {
  title?: string;
  waypoints: NavWaypoint[];
  // Khi dẫn đường xuất phát từ 1 tour đã lưu: mang theo id để trang /navigate
  // đánh dấu tour 'completed' lúc tới đích & mở lời mời đánh giá.
  tourId?: string;
}

// Lưu payload dẫn đường rồi để caller tự điều hướng sang /navigate.
export function saveNavPayload(payload: NavPayload): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // sessionStorage có thể bị chặn (private mode) — bỏ qua, trang /navigate
    // sẽ hiện empty state nếu không đọc được.
  }
}

// Đọc payload đã stash; trả null nếu chưa có hoặc parse lỗi.
export function loadNavPayload(): NavPayload | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(NAV_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NavPayload;
    if (!parsed || !Array.isArray(parsed.waypoints)) return null;
    return parsed;
  } catch {
    return null;
  }
}
