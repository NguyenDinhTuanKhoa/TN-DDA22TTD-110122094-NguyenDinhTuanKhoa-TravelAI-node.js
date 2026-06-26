'use client';
// Trạng thái vòng đời của tour đã lưu, lưu ở localStorage (giống savedTours.ts —
// tour cộng đồng không gắn user trong DB nên tiến trình "đi tour" là dữ liệu
// cá nhân theo trình duyệt). Tách riêng khỏi savedTours để không làm bẩn shape
// `Tour` (vốn mirror DB).
//
//   saved     → đã lưu, chưa đi
//   going     → đã bấm "Bắt đầu đi" (đang trên đường)
//   completed → đã đi xong (mở khoá đánh giá)
import { useEffect, useState } from 'react';

export type TourStatus = 'saved' | 'going' | 'completed';

export interface TourProgress {
  status: TourStatus;
  startedAt?: string;    // ISO, set khi chuyển sang 'going'
  completedAt?: string;  // ISO, set khi chuyển sang 'completed'
}

const KEY = 'tourProgress';
const EVENT = 'tourProgressChanged';

type ProgressMap = Record<string, TourProgress>;

function readAll(): ProgressMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ProgressMap) : {};
  } catch {
    return {};
  }
}

function persist(map: ProgressMap) {
  localStorage.setItem(KEY, JSON.stringify(map));
  window.dispatchEvent(new CustomEvent(EVENT));
}

// Trạng thái của 1 tour. Mặc định 'saved' (tour có mặt trong savedTours nhưng
// chưa có bản ghi tiến trình thì coi như mới lưu).
export function getStatus(id: string): TourStatus {
  return readAll()[id]?.status ?? 'saved';
}

export function getProgress(id: string): TourProgress | null {
  return readAll()[id] ?? null;
}

export function setTourStatus(id: string, status: TourStatus): void {
  const map = readAll();
  const prev = map[id] ?? { status: 'saved' };
  const next: TourProgress = { ...prev, status };
  if (status === 'going' && !next.startedAt) next.startedAt = new Date().toISOString();
  if (status === 'completed' && !next.completedAt) next.completedAt = new Date().toISOString();
  map[id] = next;
  persist(map);
}

// Xoá tiến trình khi người dùng bỏ lưu tour (dọn rác localStorage).
export function clearProgress(id: string): void {
  const map = readAll();
  if (map[id]) {
    delete map[id];
    persist(map);
  }
}

export const TOUR_PROGRESS_EVENT = EVENT;

// Hook đồng bộ trạng thái 1 tour qua nhiều card/tab (giống useTourSaved).
export function useTourStatus(id: string): TourStatus {
  const [status, setStatus] = useState<TourStatus>('saved');
  useEffect(() => {
    const sync = () => setStatus(getStatus(id));
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [id]);
  return status;
}
