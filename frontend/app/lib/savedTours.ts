// Lưu tour cộng đồng (/my-tours) vào localStorage.
// Các tour này là dữ liệu hardcode (không có trong DB) nên không dùng được API /saved.
import { clearProgress } from './tourProgress';

export interface TourStop {
  name: string;
  city: string;
  image: string;
  category: string;
  rating: number;
  description: string;
  // Toạ độ thật (lat/lng). Không có sẵn trong dữ liệu tour — được geocode runtime
  // qua Nominatim và đính vào khi hiển thị bản đồ. Xem app/lib/geocode.ts.
  coordinates?: { lat: number; lng: number };
}

export interface TourReview {
  userId?: string;   // có khi review do người dùng đăng (nhận diện "của tôi")
  name: string;
  avatar: string;
  date: string;
  rating: number;
  text: string;
  helpful: number;
}

export interface Tour {
  id: string;
  title: string;
  coverImage: string;
  duration: string;
  days: number;
  category: string;
  categoryIcon: string;
  region: string;
  priceRange: 'budget' | 'mid-range' | 'luxury';
  priceLabel: string;
  rating: number;
  reviewCount: number;
  viewCount: number;
  tags: string[];
  highlights: string[];
  badge: string;
  badgeColor: string;
  author: string;
  authorAvatar: string;
  completedDate: string;
  stops: TourStop[];
  reviews: TourReview[];
  description: string;
}

// Tương thích ngược: trước đây chỉ lưu metadata.
export type SavedTour = Tour;

const KEY = 'savedTours';
const EVENT = 'savedToursChanged';

// Đảm bảo các trường mảng luôn tồn tại để modal chi tiết không vỡ
// với những tour đã lưu từ phiên bản cũ (chỉ có metadata).
function normalize(t: Partial<Tour>): Tour {
  return {
    id: t.id ?? '',
    title: t.title ?? 'Tour',
    coverImage: t.coverImage ?? '',
    duration: t.duration ?? '',
    days: t.days ?? 0,
    category: t.category ?? '',
    categoryIcon: t.categoryIcon ?? '📍',
    region: t.region ?? '',
    priceRange: t.priceRange ?? 'mid-range',
    priceLabel: t.priceLabel ?? 'Liên hệ',
    rating: t.rating ?? 0,
    reviewCount: t.reviewCount ?? 0,
    viewCount: t.viewCount ?? 0,
    tags: t.tags ?? [],
    highlights: t.highlights ?? [],
    badge: t.badge ?? '',
    badgeColor: t.badgeColor ?? 'bg-sky-500',
    author: t.author ?? '',
    authorAvatar: t.authorAvatar ?? '',
    completedDate: t.completedDate ?? '',
    stops: t.stops ?? [],
    reviews: t.reviews ?? [],
    description: t.description ?? '',
  };
}

export function getSavedTours(): Tour[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as Partial<Tour>[]).map(normalize);
  } catch {
    return [];
  }
}

export function isTourSaved(id: string): boolean {
  return getSavedTours().some((t) => t.id === id);
}

function persist(tours: Tour[]) {
  localStorage.setItem(KEY, JSON.stringify(tours));
  window.dispatchEvent(new CustomEvent(EVENT));
}

// Trả về trạng thái mới: true = đã lưu, false = đã bỏ lưu.
export function toggleSavedTour(tour: Tour): boolean {
  const tours = getSavedTours();
  const index = tours.findIndex((t) => t.id === tour.id);
  if (index === -1) {
    persist([...tours, normalize(tour)]);
    return true;
  }
  persist(tours.filter((t) => t.id !== tour.id));
  clearProgress(tour.id);   // bỏ lưu → dọn luôn trạng thái vòng đời
  return false;
}

export function removeSavedTour(id: string) {
  persist(getSavedTours().filter((t) => t.id !== id));
  clearProgress(id);
}

export const SAVED_TOURS_EVENT = EVENT;
