// Client gọi API tour công khai cho trang /my-tours.
// Tour giờ lưu trong DB (trước đây hardcode). Backend trả về public shape kèm `id`.
import type { Tour } from './savedTours';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

export async function getTours(params?: {
  category?: string;
  priceRange?: string;
  search?: string;
}): Promise<Tour[]> {
  const entries = Object.entries(params || {}).filter(([, v]) => v) as [string, string][];
  const qs = entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
  const res = await fetch(`${API_URL}/tours${qs}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Không tải được danh sách tour');
  const json = await res.json();
  return (json.data || []) as Tour[];
}

export async function getTour(id: string): Promise<Tour | null> {
  const res = await fetch(`${API_URL}/tours/${id}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const json = await res.json();
  return (json.data || null) as Tour | null;
}

// Đăng/sửa đánh giá tour (cần đăng nhập). Trả về tour đã cập nhật (kèm review
// mới + rating/reviewCount tính lại) để UI refresh ngay. Ném lỗi với message từ
// server (vd chưa đăng nhập 401, sao không hợp lệ 400) để form hiển thị.
export async function postTourReview(
  id: string,
  body: { rating: number; text: string },
  token: string,
): Promise<Tour> {
  const res = await fetch(`${API_URL}/tours/${id}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(json.message || 'Không gửi được đánh giá');
  }
  return json.data as Tour;
}
