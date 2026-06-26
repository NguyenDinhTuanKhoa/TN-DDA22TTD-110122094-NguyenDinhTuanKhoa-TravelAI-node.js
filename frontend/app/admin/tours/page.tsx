'use client';
import { useState, useEffect, useCallback } from 'react';
import { adminApi } from '../../lib/adminApi';
import type { Tour, TourStop, TourReview } from '../../lib/savedTours';
import DataTable, { Column } from '../_components/DataTable';
import FilterBar from '../_components/FilterBar';
import Pagination from '../_components/Pagination';
import ConfirmModal from '../_components/ConfirmModal';
import BulkActionBar from '../_components/BulkActionBar';
import Badge from '../_components/Badge';
import EmptyState from '../_components/EmptyState';
import { toast } from '../_components/Toast';

interface AdminTour extends Tour {
  _id: string;
  source?: string;
  isPublished?: boolean;
}

// Category cấp tour (nhãn hiển thị) — khớp bộ lọc trang /my-tours + vài nhãn AI hay dùng.
const TOUR_CATEGORIES = [
  { id: 'Biển', label: '🏖️ Biển & Đảo' },
  { id: 'Núi', label: '🏔️ Núi rừng' },
  { id: 'Di sản', label: '🏛️ Di sản' },
  { id: 'Thành phố', label: '🏙️ Thành phố' },
  { id: 'Sinh thái', label: '🌿 Sinh thái' },
  { id: 'Đảo', label: '🏝️ Đảo' },
  { id: 'Văn hóa', label: '🎎 Văn hóa' },
];

const PRICE_RANGES = [
  { id: 'budget', label: '💚 Tiết kiệm' },
  { id: 'mid-range', label: '💙 Tầm trung' },
  { id: 'luxury', label: '💜 Cao cấp' },
];

// Category cấp trạm dừng (value giữ tiếng Anh vì bản đồ tour dùng để chọn icon/màu).
const STOP_CATEGORIES = [
  { id: 'beach', label: 'Biển' },
  { id: 'mountain', label: 'Núi' },
  { id: 'nature', label: 'Thiên nhiên' },
  { id: 'heritage', label: 'Di sản' },
  { id: 'city', label: 'Thành phố' },
  { id: 'island', label: 'Đảo' },
  { id: 'countryside', label: 'Nông thôn' },
];

const BADGE_COLORS = ['bg-sky-500', 'bg-red-500', 'bg-amber-500', 'bg-emerald-600', 'bg-violet-500', 'bg-pink-500'];

const priceMeta: Record<string, { color: 'emerald' | 'sky' | 'violet'; label: string }> = {
  budget: { color: 'emerald', label: 'Tiết kiệm' },
  'mid-range': { color: 'sky', label: 'Tầm trung' },
  luxury: { color: 'violet', label: 'Cao cấp' },
};

// ── Kiểu state form (mọi field text để dễ bind input) ──────────────────────────
interface StopForm {
  name: string; city: string; image: string; category: string;
  rating: string; description: string; lat: string; lng: string;
}
interface ReviewForm {
  name: string; avatar: string; date: string; rating: string; text: string; helpful: string;
}

const emptyStop = (): StopForm => ({ name: '', city: '', image: '', category: 'nature', rating: '4.5', description: '', lat: '', lng: '' });

const emptyForm = () => ({
  title: '', description: '', coverImage: '', duration: '', days: '2',
  category: 'Biển', categoryIcon: '🏖️', region: '',
  priceRange: 'mid-range', priceLabel: '', rating: '4.5', reviewCount: '0',
  tags: '', highlights: '', badge: '', badgeColor: 'bg-sky-500',
  author: 'TravelAI', authorAvatar: 'AI', completedDate: '',
});

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

const FIELD_CLS = 'w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent';

// Đọc file ảnh → resize giữ tỉ lệ (cạnh dài ≤ maxDim) → base64 JPEG (giảm dung lượng).
// Dự án không có server upload; ảnh lưu thẳng dạng data URL như avatar profile.
function fileToCompressedDataUrl(file: File, maxDim: number, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new window.Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Canvas lỗi')); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Ảnh lỗi'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Đọc file lỗi'));
    reader.readAsDataURL(file);
  });
}

// Mở hộp thoại chọn ảnh, nén rồi gọi onPicked(dataUrl).
function pickImage(maxDim: number, onPicked: (dataUrl: string) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Vui lòng chọn file ảnh'); return; }
    try {
      onPicked(await fileToCompressedDataUrl(file, maxDim));
    } catch {
      toast.error('Không xử lý được ảnh');
    }
  };
  input.click();
}

// Ô ảnh dùng chung: 2 cách — DÁN URL hoặc 📁 TẢI ẢNH LÊN (→ base64). Có preview.
function ImageField({ value, onChange, maxDim, placeholder, previewClass = 'w-40 h-24' }: {
  value: string; onChange: (v: string) => void; maxDim: number; placeholder?: string; previewClass?: string;
}) {
  const isUploaded = value?.startsWith('data:');
  return (
    <div className="space-y-2">
      {isUploaded ? (
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-emerald-700 font-semibold bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2.5">✓ Đã tải ảnh lên</span>
          <button type="button" onClick={() => onChange('')} className="px-3 py-2.5 text-xs font-semibold text-red-500 hover:bg-red-50 rounded-xl">✕ Xóa</button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className={`${FIELD_CLS} font-mono text-xs flex-1`} placeholder={placeholder || 'Dán URL ảnh...'} />
          <button type="button" onClick={() => pickImage(maxDim, onChange)} className="shrink-0 px-3 py-2.5 text-xs font-semibold text-sky-600 bg-sky-50 hover:bg-sky-100 rounded-xl whitespace-nowrap">📁 Tải lên</button>
        </div>
      )}
      {value && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="" className={`${previewClass} rounded-lg object-cover border border-gray-200`} />
      )}
    </div>
  );
}

export default function AdminTours() {
  const [tours, setTours] = useState<AdminTour[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [priceFilter, setPriceFilter] = useState('all');

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<AdminTour | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Form tạo/sửa
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [source, setSource] = useState<'manual' | 'ai'>('manual');
  const [formData, setFormData] = useState(emptyForm());
  const [stops, setStops] = useState<StopForm[]>([emptyStop()]);
  const [reviews, setReviews] = useState<ReviewForm[]>([]);

  // Modal AI
  const [showAiModal, setShowAiModal] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [aiForm, setAiForm] = useState({
    destination: '', days: '3', budget: 'trung bình',
    interests: '', audience: 'mọi đối tượng', pace: 'cân bằng',
    season: 'bất kỳ', transport: 'tự do', accommodation: 'tự do',
    fitness: 'trung bình', density: 'vừa', notes: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await adminApi.getTours({
      page, search,
      category: categoryFilter !== 'all' ? categoryFilter : undefined,
      priceRange: priceFilter !== 'all' ? priceFilter : undefined,
    });
    if (error) toast.error(error);
    if (data) {
      const r = data as { tours: AdminTour[]; totalPages: number };
      setTours(r.tours);
      setTotalPages(r.totalPages);
    }
    setLoading(false);
  }, [page, search, categoryFilter, priceFilter]);

  useEffect(() => { load(); }, [load]);

  // ── Form helpers ──────────────────────────────────────────────────────────
  const resetForm = () => {
    setEditingId(null);
    setSource('manual');
    setFormData(emptyForm());
    setStops([emptyStop()]);
    setReviews([]);
  };

  // Đổ 1 Tour (từ DB khi sửa, hoặc draft AI) vào state form.
  const fillForm = (t: Partial<Tour>) => {
    setFormData({
      title: t.title || '', description: t.description || '', coverImage: t.coverImage || '',
      duration: t.duration || '', days: String(t.days ?? 2),
      category: t.category || 'Biển', categoryIcon: t.categoryIcon || '🏖️', region: t.region || '',
      priceRange: t.priceRange || 'mid-range', priceLabel: t.priceLabel || '',
      rating: String(t.rating ?? 4.5), reviewCount: String(t.reviewCount ?? 0),
      tags: (t.tags || []).join(', '), highlights: (t.highlights || []).join(', '),
      badge: t.badge || '', badgeColor: t.badgeColor || 'bg-sky-500',
      author: t.author || 'TravelAI', authorAvatar: t.authorAvatar || 'AI', completedDate: t.completedDate || '',
    });
    setStops((t.stops && t.stops.length ? t.stops : [emptyStop() as unknown as TourStop]).map((s) => ({
      name: s.name || '', city: s.city || '', image: s.image || '', category: s.category || 'nature',
      rating: String(s.rating ?? 4.5), description: s.description || '',
      lat: s.coordinates?.lat != null ? String(s.coordinates.lat) : '',
      lng: s.coordinates?.lng != null ? String(s.coordinates.lng) : '',
    })));
    setReviews((t.reviews || []).map((r) => ({
      name: r.name || '', avatar: r.avatar || '', date: r.date || '',
      rating: String(r.rating ?? 5), text: r.text || '', helpful: String(r.helpful ?? 0),
    })));
  };

  const buildPayload = () => ({
    title: formData.title,
    description: formData.description,
    coverImage: formData.coverImage,
    duration: formData.duration,
    days: Number(formData.days) || 1,
    category: formData.category,
    categoryIcon: formData.categoryIcon,
    region: formData.region,
    priceRange: formData.priceRange,
    priceLabel: formData.priceLabel,
    rating: Number(formData.rating) || 0,
    reviewCount: Number(formData.reviewCount) || 0,
    tags: csv(formData.tags),
    highlights: csv(formData.highlights),
    badge: formData.badge,
    badgeColor: formData.badgeColor,
    author: formData.author,
    authorAvatar: formData.authorAvatar,
    completedDate: formData.completedDate,
    source,
    stops: stops
      .filter((s) => s.name.trim())
      .map((s) => {
        const lat = parseFloat(s.lat), lng = parseFloat(s.lng);
        return {
          name: s.name, city: s.city, image: s.image, category: s.category,
          rating: Number(s.rating) || 0, description: s.description,
          coordinates: !isNaN(lat) && !isNaN(lng) ? { lat, lng } : undefined,
        } as TourStop;
      }),
    reviews: reviews
      .filter((r) => r.name.trim() || r.text.trim())
      .map((r) => ({
        name: r.name, avatar: r.avatar || r.name.slice(0, 2).toUpperCase(), date: r.date,
        rating: Number(r.rating) || 5, text: r.text, helpful: Number(r.helpful) || 0,
      } as TourReview)),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!buildPayload().stops.length) {
      toast.warning('Tour cần ít nhất 1 trạm dừng có tên');
      return;
    }
    setSaving(true);
    const payload = buildPayload();
    const { error } = editingId
      ? await adminApi.updateTour(editingId, payload)
      : await adminApi.createTour(payload);
    setSaving(false);
    if (error) toast.error(error);
    else {
      toast.success(editingId ? 'Đã cập nhật tour' : 'Đã thêm tour mới');
      setShowModal(false);
      resetForm();
      load();
    }
  };

  const handleEdit = (t: AdminTour) => {
    setEditingId(t._id);
    setSource((t.source as 'manual' | 'ai') || 'manual');
    fillForm(t);
    setShowModal(true);
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setActionLoading(true);
    const { error } = await adminApi.deleteTour(confirmDelete._id);
    setActionLoading(false);
    if (error) toast.error(error);
    else {
      toast.success(`Đã xóa "${confirmDelete.title}"`);
      setConfirmDelete(null);
      load();
    }
  };

  const handleBulkDelete = async () => {
    setActionLoading(true);
    const { data, error } = await adminApi.bulkDeleteTours(selectedIds);
    setActionLoading(false);
    if (error) toast.error(error);
    else {
      const count = (data as { deletedCount: number })?.deletedCount || 0;
      toast.success(`Đã xóa ${count} tour`);
      setSelectedIds([]);
      setConfirmBulkDelete(false);
      load();
    }
  };

  // ── AI generate ────────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    setGenerating(true);
    const { data, error } = await adminApi.generateTour(aiForm);
    setGenerating(false);
    if (error) { toast.error(error); return; }
    const draft = (data as { data: Tour })?.data;
    if (!draft) { toast.error('AI không trả về dữ liệu'); return; }
    // Đổ draft vào form rồi mở modal sửa để admin review trước khi lưu.
    setEditingId(null);
    setSource('ai');
    fillForm(draft);
    setShowAiModal(false);
    setShowModal(true);
    toast.success('AI đã tạo nháp tour — kiểm tra & lưu');
  };

  // ── Stops / Reviews editors ─────────────────────────────────────────────────
  const updateStop = (i: number, patch: Partial<StopForm>) =>
    setStops((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const updateReview = (i: number, patch: Partial<ReviewForm>) =>
    setReviews((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const columns: Column<AdminTour>[] = [
    {
      key: 'title',
      header: 'Tour',
      render: (t) => (
        <div className="flex items-center gap-3 min-w-0">
          {t.coverImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={t.coverImage} alt="" className="w-14 h-12 rounded-lg object-cover shadow-sm shrink-0" />
          ) : (
            <div className="w-14 h-12 rounded-lg bg-gray-100 flex items-center justify-center text-xl shrink-0">{t.categoryIcon || '🧳'}</div>
          )}
          <div className="min-w-0">
            <p className="font-semibold text-gray-900 truncate max-w-[260px]">{t.title}</p>
            <p className="text-xs text-gray-500 truncate max-w-[260px]">{t.region} · {t.duration}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Loại',
      render: (t) => <Badge color="sky">{t.categoryIcon} {t.category}</Badge>,
    },
    {
      key: 'price',
      header: 'Giá',
      render: (t) => {
        const m = priceMeta[t.priceRange] || { color: 'sky' as const, label: t.priceRange };
        return (
          <div className="flex flex-col gap-0.5">
            <Badge color={m.color} size="sm">{m.label}</Badge>
            <span className="text-xs text-gray-500">{t.priceLabel}</span>
          </div>
        );
      },
    },
    {
      key: 'stops',
      header: 'Trạm',
      render: (t) => <span className="text-sm font-semibold text-gray-700">{t.stops?.length || 0}</span>,
    },
    {
      key: 'rating',
      header: 'Rating',
      render: (t) => (
        <div className="flex items-center gap-1 text-sm">
          <span className="text-amber-500">★</span>
          <span className="font-semibold text-gray-700">{t.rating?.toFixed(1) || '0.0'}</span>
          <span className="text-xs text-gray-400">({t.reviewCount || 0})</span>
        </div>
      ),
    },
    {
      key: 'source',
      header: 'Nguồn',
      render: (t) => t.source === 'ai'
        ? <Badge color="violet" size="sm">🤖 AI</Badge>
        : t.source === 'seed'
          ? <Badge color="gray" size="sm">📦 Seed</Badge>
          : <Badge color="emerald" size="sm">✍️ Thủ công</Badge>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (t) => (
        <div className="flex items-center justify-end gap-1.5">
          <button
            onClick={(e) => { e.stopPropagation(); handleEdit(t); }}
            className="px-3 py-1.5 text-xs font-semibold text-sky-600 hover:bg-sky-50 rounded-lg transition-colors"
          >✏️ Sửa</button>
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(t); }}
            className="px-3 py-1.5 text-xs font-semibold text-red-500 hover:bg-red-50 rounded-lg transition-colors"
          >🗑 Xóa</button>
        </div>
      ),
    },
  ];

  const inputCls = 'w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent';
  const labelCls = 'block text-sm font-semibold text-gray-700 mb-1.5';

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Quản lý Tour</h2>
          <p className="text-sm text-gray-500 mt-1">Thêm/sửa/xóa tour cộng đồng hoặc để AI tạo tour tự động từ bộ câu hỏi</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAiModal(true)}
            className="px-4 py-2.5 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white rounded-xl shadow-md shadow-violet-500/20 hover:shadow-lg transition-all flex items-center gap-2 text-sm font-semibold"
          >🤖 Tạo bằng AI</button>
          <button
            onClick={() => { resetForm(); setShowModal(true); }}
            className="px-5 py-2.5 bg-gradient-to-r from-sky-500 to-violet-500 text-white rounded-xl shadow-md shadow-violet-500/20 hover:shadow-lg hover:scale-[1.02] transition-all flex items-center gap-2 text-sm font-semibold"
          >✨ Thêm tour</button>
        </div>
      </div>

      <FilterBar
        searchValue={search}
        onSearchChange={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="Tìm theo tên tour..."
        filters={[
          {
            key: 'category', label: 'Loại', type: 'select', value: categoryFilter,
            onChange: (v) => { setCategoryFilter(v); setPage(1); },
            options: [{ value: 'all', label: 'Tất cả' }, ...TOUR_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))],
          },
          {
            key: 'price', label: 'Giá', type: 'select', value: priceFilter,
            onChange: (v) => { setPriceFilter(v); setPage(1); },
            options: [{ value: 'all', label: 'Tất cả' }, ...PRICE_RANGES.map((p) => ({ value: p.id, label: p.label }))],
          },
        ]}
        onReset={() => { setSearch(''); setCategoryFilter('all'); setPriceFilter('all'); setPage(1); }}
      />

      <DataTable<AdminTour>
        columns={columns}
        rows={tours}
        getRowId={(t) => t._id}
        selectable
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        loading={loading}
        emptyState={<EmptyState icon="🧳" title="Chưa có tour" description="Nhấn ✨ Thêm tour hoặc 🤖 Tạo bằng AI để bắt đầu." />}
      />

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      <BulkActionBar
        count={selectedIds.length}
        onClear={() => setSelectedIds([])}
        actions={
          <button
            onClick={() => setConfirmBulkDelete(true)}
            className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500 text-red-300 hover:text-white rounded-lg text-sm font-semibold transition-all"
          >🗑 Xóa tất cả</button>
        }
      />

      <ConfirmModal
        open={!!confirmDelete}
        title="Xóa tour"
        message={<>Xóa <strong>{confirmDelete?.title}</strong>? Không thể hoàn tác.</>}
        confirmLabel="Xóa" danger loading={actionLoading}
        onConfirm={handleDelete} onCancel={() => setConfirmDelete(null)}
      />
      <ConfirmModal
        open={confirmBulkDelete}
        title="Xóa nhiều tour"
        message={<>Sẽ xóa <strong>{selectedIds.length}</strong> tour. Không thể hoàn tác.</>}
        confirmLabel={`Xóa ${selectedIds.length}`} danger loading={actionLoading}
        onConfirm={handleBulkDelete} onCancel={() => setConfirmBulkDelete(false)}
      />

      {/* ── CREATE / EDIT MODAL ─────────────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 bg-gray-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto shadow-2xl">
            <div className="sticky top-0 bg-white p-6 border-b border-gray-100 z-10 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-gray-900">
                  {editingId ? '✏️ Sửa tour' : source === 'ai' ? '🤖 Nháp tour từ AI' : '✨ Thêm tour mới'}
                </h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  {source === 'ai' && !editingId ? 'Kiểm tra & chỉnh sửa trước khi lưu' : 'Điền thông tin chi tiết'}
                </p>
              </div>
              <button onClick={() => setShowModal(false)} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-lg">✕</button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-6">
              {/* Thông tin cơ bản */}
              <section className="space-y-4">
                <h4 className="font-bold text-sm uppercase tracking-wider text-gray-500">📝 Thông tin cơ bản</h4>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Tiêu đề *</label>
                    <input type="text" required value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} className={inputCls} placeholder="VD: 3 Ngày Đà Nẵng — Hội An" />
                  </div>
                  <div>
                    <label className={labelCls}>Khu vực</label>
                    <input type="text" value={formData.region} onChange={(e) => setFormData({ ...formData, region: e.target.value })} className={inputCls} placeholder="VD: Miền Trung" />
                  </div>
                </div>
                <div>
                  <label className={labelCls}>Mô tả</label>
                  <textarea rows={3} value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} className={`${inputCls} resize-none`} placeholder="Mô tả ngắn về tour..." />
                </div>
                <div className="grid md:grid-cols-3 gap-4">
                  <div>
                    <label className={labelCls}>Số ngày</label>
                    <input type="number" min={1} value={formData.days} onChange={(e) => setFormData({ ...formData, days: e.target.value })} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Thời lượng</label>
                    <input type="text" value={formData.duration} onChange={(e) => setFormData({ ...formData, duration: e.target.value })} className={inputCls} placeholder="3 ngày 2 đêm" />
                  </div>
                  <div>
                    <label className={labelCls}>Ngày hoàn thành</label>
                    <input type="text" value={formData.completedDate} onChange={(e) => setFormData({ ...formData, completedDate: e.target.value })} className={inputCls} placeholder="04/2026" />
                  </div>
                </div>
              </section>

              {/* Phân loại & giá */}
              <section className="space-y-4">
                <h4 className="font-bold text-sm uppercase tracking-wider text-gray-500">🏷 Phân loại & Giá</h4>
                <div className="grid md:grid-cols-4 gap-4">
                  <div>
                    <label className={labelCls}>Loại</label>
                    <select value={formData.category} onChange={(e) => setFormData({ ...formData, category: e.target.value })} className={inputCls}>
                      {TOUR_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Icon</label>
                    <input type="text" value={formData.categoryIcon} onChange={(e) => setFormData({ ...formData, categoryIcon: e.target.value })} className={inputCls} placeholder="🏖️" />
                  </div>
                  <div>
                    <label className={labelCls}>Mức giá</label>
                    <select value={formData.priceRange} onChange={(e) => setFormData({ ...formData, priceRange: e.target.value })} className={inputCls}>
                      {PRICE_RANGES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Giá hiển thị</label>
                    <input type="text" value={formData.priceLabel} onChange={(e) => setFormData({ ...formData, priceLabel: e.target.value })} className={inputCls} placeholder="5.500.000 ₫" />
                  </div>
                </div>
              </section>

              {/* Hiển thị */}
              <section className="space-y-4">
                <h4 className="font-bold text-sm uppercase tracking-wider text-gray-500">🖼 Hiển thị</h4>
                <div>
                  <label className={labelCls}>Ảnh bìa (dán URL hoặc tải ảnh lên)</label>
                  <ImageField
                    value={formData.coverImage}
                    onChange={(v) => setFormData({ ...formData, coverImage: v })}
                    maxDim={1200}
                    placeholder="Dán URL ảnh bìa..."
                    previewClass="w-48 h-28"
                  />
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Tags (phẩy)</label>
                    <input type="text" value={formData.tags} onChange={(e) => setFormData({ ...formData, tags: e.target.value })} className={inputCls} placeholder="Biển, Ẩm thực, Nghỉ dưỡng" />
                  </div>
                  <div>
                    <label className={labelCls}>Điểm nhấn (phẩy)</label>
                    <input type="text" value={formData.highlights} onChange={(e) => setFormData({ ...formData, highlights: e.target.value })} className={inputCls} placeholder="Cầu Vàng, Phố cổ Hội An" />
                  </div>
                </div>
                <div className="grid md:grid-cols-4 gap-4">
                  <div>
                    <label className={labelCls}>Badge</label>
                    <input type="text" value={formData.badge} onChange={(e) => setFormData({ ...formData, badge: e.target.value })} className={inputCls} placeholder="🔥 Phổ biến" />
                  </div>
                  <div>
                    <label className={labelCls}>Màu badge</label>
                    <select value={formData.badgeColor} onChange={(e) => setFormData({ ...formData, badgeColor: e.target.value })} className={inputCls}>
                      {BADGE_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Rating</label>
                    <input type="number" step="0.1" min={0} max={5} value={formData.rating} onChange={(e) => setFormData({ ...formData, rating: e.target.value })} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Số đánh giá</label>
                    <input type="number" min={0} value={formData.reviewCount} onChange={(e) => setFormData({ ...formData, reviewCount: e.target.value })} className={inputCls} />
                  </div>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className={labelCls}>Tác giả</label>
                    <input type="text" value={formData.author} onChange={(e) => setFormData({ ...formData, author: e.target.value })} className={inputCls} />
                  </div>
                  <div>
                    <label className={labelCls}>Avatar tác giả (2 chữ)</label>
                    <input type="text" value={formData.authorAvatar} onChange={(e) => setFormData({ ...formData, authorAvatar: e.target.value })} className={inputCls} placeholder="TK" />
                  </div>
                </div>
              </section>

              {/* Trạm dừng */}
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-sm uppercase tracking-wider text-gray-500">📍 Trạm dừng ({stops.length})</h4>
                  <button type="button" onClick={() => setStops([...stops, emptyStop()])} className="px-3 py-1.5 text-xs font-semibold text-sky-600 hover:bg-sky-50 rounded-lg">+ Thêm trạm</button>
                </div>
                <div className="space-y-3">
                  {stops.map((s, i) => (
                    <div key={i} className="p-4 bg-gray-50 border border-gray-100 rounded-xl space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-gray-500">Trạm {i + 1}</span>
                        {stops.length > 1 && (
                          <button type="button" onClick={() => setStops(stops.filter((_, idx) => idx !== i))} className="text-xs text-red-500 hover:underline">Xóa</button>
                        )}
                      </div>
                      <div className="grid md:grid-cols-3 gap-3">
                        <input value={s.name} onChange={(e) => updateStop(i, { name: e.target.value })} className={inputCls} placeholder="Tên trạm *" />
                        <input value={s.city} onChange={(e) => updateStop(i, { city: e.target.value })} className={inputCls} placeholder="Thành phố" />
                        <select value={s.category} onChange={(e) => updateStop(i, { category: e.target.value })} className={inputCls}>
                          {STOP_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                      </div>
                      <input value={s.description} onChange={(e) => updateStop(i, { description: e.target.value })} className={inputCls} placeholder="Mô tả ngắn" />
                      <div className="grid md:grid-cols-3 gap-3">
                        <input value={s.lat} onChange={(e) => updateStop(i, { lat: e.target.value })} className={`${inputCls} font-mono text-xs`} placeholder="lat (vd 16.05)" />
                        <input value={s.lng} onChange={(e) => updateStop(i, { lng: e.target.value })} className={`${inputCls} font-mono text-xs`} placeholder="lng (vd 108.2)" />
                        <input type="number" step="0.1" min={0} max={5} value={s.rating} onChange={(e) => updateStop(i, { rating: e.target.value })} className={inputCls} placeholder="Rating" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gray-500 mb-1">Ảnh trạm (tùy chọn)</label>
                        <ImageField
                          value={s.image}
                          onChange={(v) => updateStop(i, { image: v })}
                          maxDim={800}
                          placeholder="Dán URL ảnh trạm..."
                          previewClass="w-28 h-20"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* Đánh giá (tùy chọn) */}
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-sm uppercase tracking-wider text-gray-500">💬 Đánh giá ({reviews.length})</h4>
                  <button type="button" onClick={() => setReviews([...reviews, { name: '', avatar: '', date: '', rating: '5', text: '', helpful: '0' }])} className="px-3 py-1.5 text-xs font-semibold text-sky-600 hover:bg-sky-50 rounded-lg">+ Thêm đánh giá</button>
                </div>
                {reviews.map((r, i) => (
                  <div key={i} className="p-4 bg-gray-50 border border-gray-100 rounded-xl space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-gray-500">Đánh giá {i + 1}</span>
                      <button type="button" onClick={() => setReviews(reviews.filter((_, idx) => idx !== i))} className="text-xs text-red-500 hover:underline">Xóa</button>
                    </div>
                    <div className="grid md:grid-cols-4 gap-3">
                      <input value={r.name} onChange={(e) => updateReview(i, { name: e.target.value })} className={inputCls} placeholder="Tên" />
                      <input value={r.date} onChange={(e) => updateReview(i, { date: e.target.value })} className={inputCls} placeholder="03/2026" />
                      <input type="number" step="0.1" min={0} max={5} value={r.rating} onChange={(e) => updateReview(i, { rating: e.target.value })} className={inputCls} placeholder="Rating" />
                      <input type="number" min={0} value={r.helpful} onChange={(e) => updateReview(i, { helpful: e.target.value })} className={inputCls} placeholder="Hữu ích" />
                    </div>
                    <textarea rows={2} value={r.text} onChange={(e) => updateReview(i, { text: e.target.value })} className={`${inputCls} resize-none`} placeholder="Nội dung đánh giá" />
                  </div>
                ))}
              </section>

              <div className="flex gap-3 pt-4 border-t border-gray-100">
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 px-5 py-3 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 font-semibold text-sm">Hủy</button>
                <button type="submit" disabled={saving} className="flex-1 px-5 py-3 bg-gradient-to-r from-sky-500 to-violet-500 text-white rounded-xl hover:shadow-lg hover:shadow-violet-500/30 font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2">
                  {saving && <span className="animate-spin">⏳</span>}
                  {editingId ? '💾 Cập nhật' : '✨ Lưu tour'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── AI GENERATE MODAL ───────────────────────────────────────────────── */}
      {showAiModal && (
        <div className="fixed inset-0 bg-gray-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-gray-200 rounded-2xl w-full max-w-2xl max-h-[92vh] flex flex-col shadow-2xl">
            <div className="p-6 border-b border-gray-100 flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-xl font-bold text-gray-900">🤖 Tạo tour bằng AI</h3>
                <p className="text-sm text-gray-500 mt-0.5">Trả lời bộ câu hỏi, AI sẽ dựng nháp tour kèm ảnh thật</p>
              </div>
              <button onClick={() => setShowAiModal(false)} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-lg">✕</button>
            </div>
            <div className="p-6 space-y-4 flex-1 overflow-y-auto">
              <div>
                <label className={labelCls}>Điểm đến / khu vực</label>
                <input type="text" value={aiForm.destination} onChange={(e) => setAiForm({ ...aiForm, destination: e.target.value })} className={inputCls} placeholder="VD: Đà Nẵng, Tây Bắc, miền Tây..." />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Số ngày</label>
                  <input type="number" min={1} value={aiForm.days} onChange={(e) => setAiForm({ ...aiForm, days: e.target.value })} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Ngân sách</label>
                  <select value={aiForm.budget} onChange={(e) => setAiForm({ ...aiForm, budget: e.target.value })} className={inputCls}>
                    <option value="tiết kiệm">Tiết kiệm</option>
                    <option value="trung bình">Trung bình</option>
                    <option value="cao cấp">Cao cấp</option>
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Sở thích / chủ đề</label>
                <input type="text" value={aiForm.interests} onChange={(e) => setAiForm({ ...aiForm, interests: e.target.value })} className={inputCls} placeholder="VD: biển, ẩm thực, văn hóa, check-in..." />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Đối tượng đi</label>
                  <select value={aiForm.audience} onChange={(e) => setAiForm({ ...aiForm, audience: e.target.value })} className={inputCls}>
                    <option value="mọi đối tượng">Mọi đối tượng</option>
                    <option value="gia đình">Gia đình</option>
                    <option value="cặp đôi">Cặp đôi</option>
                    <option value="nhóm bạn">Nhóm bạn</option>
                    <option value="phượt thủ">Phượt thủ</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Nhịp độ</label>
                  <select value={aiForm.pace} onChange={(e) => setAiForm({ ...aiForm, pace: e.target.value })} className={inputCls}>
                    <option value="thư giãn">Thư giãn</option>
                    <option value="cân bằng">Cân bằng</option>
                    <option value="dày đặc">Dày đặc</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Mùa / thời điểm</label>
                  <select value={aiForm.season} onChange={(e) => setAiForm({ ...aiForm, season: e.target.value })} className={inputCls}>
                    <option value="bất kỳ">Bất kỳ</option>
                    <option value="mùa xuân">Mùa xuân</option>
                    <option value="mùa hè">Mùa hè</option>
                    <option value="mùa thu">Mùa thu</option>
                    <option value="mùa đông">Mùa đông</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Phương tiện</label>
                  <select value={aiForm.transport} onChange={(e) => setAiForm({ ...aiForm, transport: e.target.value })} className={inputCls}>
                    <option value="tự do">Tự do</option>
                    <option value="xe máy">Xe máy</option>
                    <option value="ô tô tự lái">Ô tô tự lái</option>
                    <option value="máy bay">Máy bay</option>
                    <option value="tàu hỏa">Tàu hỏa</option>
                    <option value="xe khách">Xe khách</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Lưu trú</label>
                  <select value={aiForm.accommodation} onChange={(e) => setAiForm({ ...aiForm, accommodation: e.target.value })} className={inputCls}>
                    <option value="tự do">Tự do</option>
                    <option value="homestay">Homestay</option>
                    <option value="khách sạn">Khách sạn</option>
                    <option value="resort">Resort</option>
                    <option value="cắm trại">Cắm trại</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Thể lực</label>
                  <select value={aiForm.fitness} onChange={(e) => setAiForm({ ...aiForm, fitness: e.target.value })} className={inputCls}>
                    <option value="nhẹ nhàng">Nhẹ nhàng</option>
                    <option value="trung bình">Trung bình</option>
                    <option value="mạo hiểm">Mạo hiểm (trekking)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Mật độ điểm mỗi ngày</label>
                <select value={aiForm.density} onChange={(e) => setAiForm({ ...aiForm, density: e.target.value })} className={inputCls}>
                  <option value="thưa">Thưa (ít điểm, thong thả)</option>
                  <option value="vừa">Vừa</option>
                  <option value="dày">Dày (nhiều điểm)</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Ghi chú / yêu cầu riêng</label>
                <textarea rows={2} value={aiForm.notes} onChange={(e) => setAiForm({ ...aiForm, notes: e.target.value })} className={`${inputCls} resize-none`} placeholder="VD: có trẻ nhỏ, ưu tiên ăn chay, tránh leo núi, ngân sách ~5 triệu..." />
              </div>
            </div>
            <div className="p-6 border-t border-gray-100 bg-gray-50 flex gap-3 shrink-0">
              <button onClick={() => setShowAiModal(false)} disabled={generating} className="flex-1 px-5 py-3 bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 font-semibold text-sm disabled:opacity-50">Hủy</button>
              <button onClick={handleGenerate} disabled={generating} className="flex-1 px-5 py-3 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white rounded-xl hover:shadow-lg font-semibold text-sm disabled:opacity-50 flex items-center justify-center gap-2">
                {generating ? <><span className="animate-spin">⏳</span> Đang tạo (có thể mất ~10-20s)...</> : '✨ Tạo nháp tour'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
