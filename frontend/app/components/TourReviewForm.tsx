'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../context/AuthContext';
import { postTourReview } from '../lib/tours';
import type { Tour } from '../lib/savedTours';

// Form đánh giá tour: chọn sao (1–5) + bình luận. Dùng lại ở tab "Đánh giá"
// trong TourDetailModal và ở màn hình hoàn thành của trang /navigate.
// Chỉ render khi đã đăng nhập; on submit gọi API rồi trả tour đã cập nhật.
export default function TourReviewForm({
  tourId,
  existing,
  onSubmitted,
}: {
  tourId: string;
  existing?: { rating: number; text: string };
  onSubmitted: (tour: Tour) => void;
}) {
  const { user, token } = useAuth();
  const [rating, setRating] = useState(existing?.rating ?? 5);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState(existing?.text ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!user || !token) {
    return (
      <div className="rounded-2xl border border-sky-100 bg-sky-50 p-4 text-center">
        <p className="text-sm text-gray-600 mb-2">Đăng nhập để chia sẻ đánh giá của bạn.</p>
        <Link
          href="/login"
          className="inline-block px-4 py-2 bg-sky-500 text-white rounded-xl text-sm font-bold hover:bg-sky-600 transition-all"
        >
          Đăng nhập
        </Link>
      </div>
    );
  }

  const submit = async () => {
    setSubmitting(true);
    setError('');
    try {
      const updated = await postTourReview(tourId, { rating, text: text.trim() }, token);
      onSubmitted(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không gửi được đánh giá');
    } finally {
      setSubmitting(false);
    }
  };

  const shown = hover || rating;
  return (
    <div className="rounded-2xl border border-amber-100 bg-amber-50/60 p-4">
      <p className="text-sm font-bold text-gray-800 mb-2">
        {existing ? '✏️ Sửa đánh giá của bạn' : '⭐ Đánh giá tour này'}
      </p>

      {/* Chọn sao */}
      <div className="flex items-center gap-1 mb-3" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((i) => (
          <button
            key={i}
            type="button"
            onMouseEnter={() => setHover(i)}
            onClick={() => setRating(i)}
            aria-label={`${i} sao`}
            className={`transition-transform hover:scale-110 ${i <= shown ? 'text-yellow-400' : 'text-gray-300'}`}
          >
            <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
          </button>
        ))}
        <span className="ml-2 text-sm font-bold text-gray-700">{rating}/5</span>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Chia sẻ trải nghiệm của bạn về tour này…"
        className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-amber-300 resize-none"
      />

      {error && <p className="mt-2 text-xs font-semibold text-red-500">{error}</p>}

      <button
        onClick={submit}
        disabled={submitting}
        className="mt-3 w-full py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white text-sm font-bold shadow hover:shadow-lg hover:shadow-amber-500/25 transition-all disabled:opacity-60"
      >
        {submitting ? 'Đang gửi…' : existing ? 'Cập nhật đánh giá' : 'Gửi đánh giá'}
      </button>
    </div>
  );
}
