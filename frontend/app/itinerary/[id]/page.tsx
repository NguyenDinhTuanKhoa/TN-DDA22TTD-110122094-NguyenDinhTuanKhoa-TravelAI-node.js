'use client';
import { useState, useEffect, Suspense } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Navbar from '../../components/Navbar';
import Footer from '../../components/Footer';
import { useAuth } from '../../context/AuthContext';
import ShareItineraryModal from '../../components/chat/ShareItineraryModal';
import dynamic from 'next/dynamic';
import { saveNavPayload } from '../../lib/navHandoff';

const ItineraryMap = dynamic(() => import('../../components/ItineraryMap'), { ssr: false });

interface Destination {
  _id: string;
  name: string;
  images: string[];
  location: { city: string; country: string; coordinates?: { lat: number; lng: number } };
  category: string;
  rating: number;
  description?: string;
}

interface ItineraryDestination {
  destination: Destination;
  order: number;
  notes: string;
  activities: string[];
}

interface Itinerary {
  _id: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  status: string;
  destinations: ItineraryDestination[];
  budget: { estimated: number; actual: number };
}

const statusOptions = [
  { value: 'planning', label: 'Đang lên kế hoạch', color: 'bg-amber-100 text-amber-700 border-amber-300', dot: 'bg-amber-400' },
  { value: 'ongoing', label: 'Đang diễn ra', color: 'bg-emerald-100 text-emerald-700 border-emerald-300', dot: 'bg-emerald-400' },
  { value: 'completed', label: 'Đã hoàn thành', color: 'bg-gray-100 text-gray-600 border-gray-300', dot: 'bg-gray-400' },
];

const categoryIcons: Record<string, string> = {
  beach: '🏖️', mountain: '🏔️', city: '🏙️', countryside: '🌾',
  heritage: '🏛️', nature: '🌿', island: '🏝️', default: '📍'
};

// ── Shared helpers (sắp xếp lộ trình + Danh sách trạm dừng) ──
const haversine = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

const hasCoords = (d: Destination) =>
  d?.location?.coordinates?.lat != null && d?.location?.coordinates?.lng != null;

// Nearest Neighbor Algorithm — trả về mảng Destination đã sắp xếp tối ưu
const nearestNeighborSort = (stops: Destination[]): Destination[] => {
  if (stops.length <= 2) return stops;
  if (!stops.every(hasCoords)) return stops; // fallback nếu thiếu tọa độ

  const visited = new Array(stops.length).fill(false);
  const result: Destination[] = [];
  let current = 0;
  visited[current] = true;
  result.push(stops[current]);

  for (let step = 1; step < stops.length; step++) {
    const cur = stops[current];
    let nearestIdx = -1;
    let nearestDist = Infinity;
    stops.forEach((d, i) => {
      if (visited[i]) return;
      const dist = haversine(
        cur.location.coordinates!.lat!, cur.location.coordinates!.lng!,
        d.location.coordinates!.lat!,  d.location.coordinates!.lng!
      );
      if (dist < nearestDist) { nearestDist = dist; nearestIdx = i; }
    });
    if (nearestIdx !== -1) { visited[nearestIdx] = true; result.push(stops[nearestIdx]); current = nearestIdx; }
  }
  return result;
};

// ── Component: Mô tả lịch trình với Markdown ──
function DescriptionPanel({ description }: { description: string }) {
  const [expanded, setExpanded] = useState(true);
  const isLong = description.length > 800;
  const preview = isLong && !expanded ? description.substring(0, 800) + '...' : description;

  return (
    <div className="mt-8 rounded-3xl overflow-hidden shadow-md border border-sky-100">
      {/* Header */}
      <div className="bg-gradient-to-r from-sky-500 to-violet-600 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center text-lg backdrop-blur-sm">🤖</div>
          <div>
            <p className="text-white font-bold text-sm">Kế hoạch từ AI</p>
            <p className="text-white/70 text-xs">Được tạo bởi TravelAI Assistant</p>
          </div>
        </div>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="px-3 py-1.5 bg-white/20 hover:bg-white/30 text-white text-xs font-semibold rounded-xl transition-all backdrop-blur-sm border border-white/20"
          >
            {expanded ? '▲ Thu gọn' : '▼ Xem đầy đủ'}
          </button>
        )}
      </div>

      {/* Content */}
      <div className="bg-white px-6 py-5">
        <div className="prose prose-sm max-w-none
          prose-headings:text-gray-800 prose-headings:font-bold prose-headings:mt-4 prose-headings:mb-2
          prose-h3:text-base prose-h3:text-sky-700
          prose-p:text-gray-600 prose-p:leading-relaxed prose-p:my-1.5
          prose-ul:my-1.5 prose-li:text-gray-600 prose-li:my-0.5
          prose-strong:text-gray-800 prose-strong:font-semibold
          prose-hr:border-gray-200
          prose-table:my-3 prose-table:text-sm prose-table:border prose-table:border-gray-200
          prose-thead:bg-sky-50 prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:font-semibold prose-th:text-gray-700 prose-th:border prose-th:border-gray-200
          prose-td:px-3 prose-td:py-2 prose-td:align-top prose-td:border prose-td:border-gray-200">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview}</ReactMarkdown>
        </div>

        {isLong && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="mt-3 w-full py-2 text-center text-sky-600 hover:text-sky-700 text-sm font-semibold border-t border-gray-100 hover:bg-sky-50 transition-all rounded-b-xl"
          >
            Xem toàn bộ kế hoạch ↓
          </button>
        )}
      </div>
    </div>
  );
}

export default function ItineraryDetailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="animate-spin w-12 h-12 border-4 border-sky-500 border-t-transparent rounded-full" /></div>}>
      <ItineraryDetailContent />
    </Suspense>
  );
}

function ItineraryDetailContent() {

  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeNode, setActiveNode] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({ title: '', description: '', status: '' });
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizeMsg, setOptimizeMsg] = useState<string | null>(null);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isOwner, setIsOwner] = useState(true);
  const [shareModalOpen, setShareModalOpen] = useState(false);

  const isSharedView = searchParams.get('shared') === '1';
  const readOnly = !isOwner || isSharedView;

  // Weather state
  const [weatherData, setWeatherData] = useState<{
    status: 'ok' | 'rain' | 'storm';
    description: string;
    days: { date: string; code: number; precip: number }[];
  } | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.push('/login'); return; }
    loadItinerary();
  }, [user, authLoading, params.id]);

  const loadItinerary = async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/itineraries/${params.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        setItinerary(data.data);
        setIsOwner(data.isOwner !== false);
        setEditData({ title: data.data.title, description: data.data.description || '', status: data.data.status });
      }
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleSave = async () => {
    const token = localStorage.getItem('token');
    if (!token || !itinerary) return;
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/itineraries/${itinerary._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(editData)
      });
      const data = await res.json();
      if (data.success) { setItinerary(data.data); setEditing(false); }
    } catch (e) { console.error(e); }
  };

  const handleRemoveDestination = async (destId: string) => {
    if (!confirm('Xóa điểm này khỏi hành trình?')) return;
    const token = localStorage.getItem('token');
    if (!token || !itinerary) return;
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/itineraries/${itinerary._id}/destinations/${destId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) { loadItinerary(); setActiveNode(null); }
    } catch (e) { console.error(e); }
  };

  const handleOptimize = async () => {
    if (!itinerary) return;
    setIsOptimizing(true);
    setOptimizeMsg(null);
    const token = localStorage.getItem('token');

    // Kiểm tra xem có tọa độ để tối ưu phía backend không
    const allHaveCoords = itinerary.destinations
      .map(d => d.destination)
      .filter(Boolean)
      .every(hasCoords);

    if (!allHaveCoords) {
      // Fallback: Sắp xếp client-side bằng Nearest Neighbor
      const stops = itinerary.destinations.map(d => d.destination).filter(Boolean) as Destination[];
      const sorted = nearestNeighborSort(stops);

      // Cập nhật lại thứ tự hiển thị trong state (chỉ UI, không gọi API)
      const newDests = sorted.map((dest, order) => {
        const original = itinerary.destinations.find(d => d.destination?._id === dest._id);
        return { ...original!, destination: dest, order };
      });
      setItinerary(prev => prev ? { ...prev, destinations: newDests } : prev);
      setOptimizeMsg('✅ Đã sắp xếp lại theo thứ tự đường đi tối ưu (chế độ offline)');
      setTimeout(() => setOptimizeMsg(null), 4000);
      setIsOptimizing(false);
      return;
    }

    // Gọi API backend (chỉ khi đủ tọa độ)
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/itineraries/${itinerary._id}/optimize`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        setOptimizeMsg(data.message);
        await loadItinerary();
        setTimeout(() => setOptimizeMsg(null), 4000);
      }
    } catch (e) { console.error(e); }
    setIsOptimizing(false);
  };

  const handleDelete = async () => {
    if (!confirm('Xóa toàn bộ lịch trình này?')) return;
    const token = localStorage.getItem('token');
    if (!token || !itinerary) return;
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/itineraries/${itinerary._id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) router.push('/itinerary');
    } catch (e) { console.error(e); }
  };

  // ── Fetch thời tiết từ Open-Meteo (miễn phí, không cần API key) ─────────────
  useEffect(() => {
    if (!itinerary) return;

    // Tìm tọa độ đại diện (ưu tiên điểm đầu tiên có tọa độ)
    const destWithCoords = itinerary.destinations
      .map(d => d.destination)
      .filter(d => d?.location?.coordinates?.lat && d?.location?.coordinates?.lng)[0];

    if (!destWithCoords) return;
    const { lat, lng } = destWithCoords.location.coordinates!;

    const startDate = new Date(itinerary.startDate).toISOString().split('T')[0];
    const endDate = new Date(itinerary.endDate).toISOString().split('T')[0];

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=weathercode,precipitation_sum&timezone=Asia%2FHo_Chi_Minh&start_date=${startDate}&end_date=${endDate}`;

    fetch(url)
      .then(r => r.json())
      .then(data => {
        const codes: number[] = data.daily?.weathercode || [];
        const precips: number[] = data.daily?.precipitation_sum || [];
        const dates: string[] = data.daily?.time || [];

        const days = dates.map((date, i) => ({
          date,
          code: codes[i] ?? 0,
          precip: precips[i] ?? 0,
        }));

        // Determine overall status
        const hasStorm = days.some(d => d.code >= 95);
        const hasRain = days.some(d => d.code >= 61 || d.precip > 5);

        if (hasStorm) {
          setWeatherData({ status: 'storm', description: 'Có thể có dông/bão trong hành trình!', days });
        } else if (hasRain) {
          setWeatherData({ status: 'rain', description: 'Dự báo có mưa trong một số ngày', days });
        } else {
          setWeatherData({ status: 'ok', description: 'Thời tiết thuận lợi cho chuyến đi', days });
        }
      })
      .catch(() => {}); // Fail silently nếu offline
  }, [itinerary]);

  // ── Xuất PDF (in trực tiếp từ DOM -> tiếng Việt chuẩn, markdown đúng, tự chia trang) ──
  const handleExportPDF = async () => {
    if (!itinerary) return;
    setIsExportingPdf(true);

    const node = document.getElementById('pdf-export-content');
    if (!node) { setIsExportingPdf(false); return; }

    try {
      // Chờ các ảnh (QR...) tải xong để không bị trắng khi in
      node.classList.remove('hidden');
      await Promise.all(
        Array.from(node.querySelectorAll('img')).map(img =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>(res => { img.onload = img.onerror = () => res(); })
        )
      );

      const win = window.open('', '_blank', 'width=900,height=1000');
      if (!win) {
        alert('Trình duyệt đã chặn cửa sổ in. Vui lòng cho phép pop-up rồi thử lại.');
        return;
      }

      const title = `TravelAI - ${itinerary.title}`.replace(/[<>]/g, '');
      win.document.write(`<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: Arial, 'Helvetica Neue', sans-serif; background: #fff; }
  #pdf-export-content { width: 100% !important; max-width: 100% !important; padding: 0 !important; }
  #pdf-export-content * { max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
  img { max-width: 100%; }
</style></head><body>${node.outerHTML}</body></html>`);
      win.document.close();

      // Đợi layout + ảnh trong cửa sổ mới sẵn sàng rồi in
      await new Promise<void>(res => {
        if (win.document.readyState === 'complete') return res();
        win.onload = () => res();
        setTimeout(res, 800); // fallback
      });

      // Đóng cửa sổ SAU khi in xong (không đóng theo giờ -> tránh hủy lưu file)
      win.onafterprint = () => { try { win.close(); } catch { /* ignore */ } };
      win.focus();
      win.print();
    } catch (e) {
      console.error('PDF export error:', e);
      alert('Xuất PDF thất bại, thử lại sau.');
    } finally {
      node.classList.add('hidden');
      setIsExportingPdf(false);
    }
  };

  const getDayCount = () => {

    if (!itinerary) return 0;
    const s = new Date(itinerary.startDate), e = new Date(itinerary.endDate);
    return Math.ceil((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  };

  const getStatusInfo = (s: string) => statusOptions.find(o => o.value === s) || statusOptions[0];

  const renderStars = (rating: number) => {
    const full = Math.floor(rating);
    return Array.from({ length: 5 }, (_, i) => (
      <span key={i} className={`text-sm ${i < full ? 'text-yellow-400' : 'text-gray-300'}`}>★</span>
    ));
  };

  if (authLoading) return (
    <div className="min-h-screen bg-gradient-to-b from-sky-200 via-green-100 to-green-200 flex items-center justify-center">
      <div className="text-center">
        <div className="text-6xl animate-bounce mb-4">🗺️</div>
        <p className="text-green-800 font-semibold text-lg">Đang xác thực...</p>
      </div>
    </div>
  );

  if (!user) return null;

  if (loading) return (
    <div className="min-h-screen bg-gradient-to-b from-sky-200 via-green-100 to-green-200 flex items-center justify-center">
      <div className="text-center">
        <div className="text-6xl animate-bounce mb-4">🗺️</div>
        <p className="text-green-800 font-semibold text-lg">Đang tải bản đồ hành trình...</p>
      </div>
    </div>
  );

  if (!itinerary) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <p className="text-6xl mb-4">📅</p>
        <p className="text-gray-500 mb-4">Không tìm thấy lịch trình</p>
        <Link href="/itinerary" className="text-sky-500 hover:underline">← Quay lại danh sách</Link>
      </div>
    </div>
  );

  const statusInfo = getStatusInfo(itinerary.status);
  const dests = itinerary.destinations;

  // displayDests: đã sắp xếp Nearest Neighbor — dùng cho Game Map + Danh sách + Dẫn đường
  const displayDests = (() => {
    const rawStops = dests.map(d => d.destination).filter(Boolean) as Destination[];
    const sortedStops = nearestNeighborSort(rawStops);
    return sortedStops.map(dest => {
      const original = dests.find(d => d.destination?._id === dest._id);
      return { ...original!, destination: dest } as ItineraryDestination;
    });
  })();

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />

      <div className="pt-20 pb-12">
        {/* ── PREMIUM HEADER BANNER ── */}
        <div className="relative overflow-hidden" style={{ minHeight: 280 }}>
          {/* Background: first destination image or gradient */}
          {dests[0]?.destination?.images?.[0] ? (
            <div className="absolute inset-0">
              <img
                src={dests[0].destination.images[0]}
                alt=""
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-r from-slate-900/95 via-slate-900/80 to-slate-900/50" />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-900/80 via-transparent to-transparent" />
            </div>
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-blue-950 to-violet-950" />
          )}

          {/* Animated orbs */}
          <div className="absolute top-0 right-0 w-96 h-96 bg-violet-500/20 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3 animate-pulse" />
          <div className="absolute bottom-0 left-1/4 w-64 h-64 bg-sky-500/20 rounded-full blur-3xl translate-y-1/2 animate-pulse" style={{ animationDelay: '1s' }} />

          {/* Sparkle dots */}
          {[...Array(8)].map((_, i) => (
            <div key={i} className="absolute w-1 h-1 bg-white rounded-full animate-ping opacity-30"
              style={{ left: `${10 + i * 12}%`, top: `${20 + (i % 3) * 25}%`, animationDelay: `${i * 0.4}s`, animationDuration: '3s' }} />
          ))}

          <div className="relative z-10 max-w-5xl mx-auto px-4 pt-8 pb-10">
            {/* Read-only banner */}
            {readOnly && (
              <div className="mb-4 flex items-center gap-3 bg-amber-500/15 backdrop-blur-md border border-amber-300/30 rounded-2xl px-4 py-3 text-amber-100">
                <span className="text-xl">👁️</span>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm">Bạn đang xem lịch trình được chia sẻ</p>
                  <p className="text-xs text-amber-200/80">Chỉ chủ lịch trình mới có thể chỉnh sửa hoặc xóa nội dung.</p>
                </div>
              </div>
            )}

            {/* Breadcrumb */}
            <div className="flex items-center gap-2 text-white/50 text-sm mb-6">
              <Link href="/itinerary" className="hover:text-white/90 transition-colors flex items-center gap-1.5 group">
                <span className="group-hover:-translate-x-0.5 transition-transform">←</span>
                <span>Lịch trình của bạn</span>
              </Link>
              <span className="text-white/30">/</span>
              <span className="text-white/70 truncate max-w-xs">{itinerary.title}</span>
            </div>

            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
              <div className="flex-1 min-w-0">
                {/* Status badge */}
                <div className="inline-flex items-center gap-2 mb-4">
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border backdrop-blur-sm ${statusInfo.color}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${statusInfo.dot} animate-pulse`} />
                    {statusInfo.label}
                  </span>
                </div>

                {/* Title */}
                {editing ? (
                  <input
                    value={editData.title}
                    onChange={e => setEditData({ ...editData, title: e.target.value })}
                    className="text-3xl md:text-4xl font-black bg-white/10 text-white border-b-2 border-white/40 outline-none w-full mb-3 px-3 py-2 rounded-xl backdrop-blur-sm"
                  />
                ) : (
                  <h1 className="text-3xl md:text-5xl font-black text-white mb-3 leading-tight"
                    style={{ textShadow: '0 2px 20px rgba(0,0,0,0.5)' }}>
                    {itinerary.title}
                  </h1>
                )}

                {/* Stats row */}
                <div className="flex flex-wrap gap-3 mt-2">
                  {/* Date range pill */}
                  <div className="flex items-center gap-2 bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl px-4 py-2">
                    <span className="text-sky-300 text-base">📅</span>
                    <div>
                      <p className="text-white/50 text-[10px] font-medium uppercase tracking-wider">Thời gian</p>
                      <p className="text-white text-sm font-semibold">
                        {new Date(itinerary.startDate).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}
                        <span className="text-white/50 mx-1">→</span>
                        {new Date(itinerary.endDate).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                      </p>
                    </div>
                  </div>

                  {/* Days pill */}
                  <div className="flex items-center gap-2 bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl px-4 py-2">
                    <span className="text-violet-300 text-base">🗓️</span>
                    <div>
                      <p className="text-white/50 text-[10px] font-medium uppercase tracking-wider">Số ngày</p>
                      <p className="text-white text-sm font-semibold">{getDayCount()} ngày</p>
                    </div>
                  </div>

                  {/* Destinations pill */}
                  <div className="flex items-center gap-2 bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl px-4 py-2">
                    <span className="text-emerald-300 text-base">📍</span>
                    <div>
                      <p className="text-white/50 text-[10px] font-medium uppercase tracking-wider">Điểm đến</p>
                      <p className="text-white text-sm font-semibold">{dests.length} trạm</p>
                    </div>
                  </div>

                  {/* Destination icons preview */}
                  {dests.length > 0 && (
                    <div className="flex items-center gap-1 bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl px-3 py-2">
                      <div className="flex -space-x-2">
                        {dests.slice(0, 4).map((d, i) => (
                          <div key={i} className="w-7 h-7 rounded-full border-2 border-white/40 overflow-hidden shadow-lg"
                            style={{ zIndex: 10 - i }}>
                            {d.destination?.images?.[0] ? (
                              <img src={d.destination.images[0]} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full bg-gradient-to-br from-sky-400 to-violet-600 flex items-center justify-center text-xs font-bold text-white">{i + 1}</div>
                            )}
                          </div>
                        ))}
                        {dests.length > 4 && (
                          <div className="w-7 h-7 rounded-full border-2 border-white/40 bg-white/20 flex items-center justify-center text-xs font-bold text-white">
                            +{dests.length - 4}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 shrink-0">
                {readOnly ? (
                  <div className="px-4 py-2.5 bg-amber-500/20 backdrop-blur-sm text-amber-100 rounded-2xl border border-amber-300/30 text-sm font-semibold flex items-center gap-2">
                    👁️ Chỉ xem
                  </div>
                ) : editing ? (
                  <>
                    <button onClick={handleSave}
                      className="px-5 py-2.5 bg-white text-slate-800 font-bold rounded-2xl hover:bg-sky-50 transition-all shadow-xl shadow-black/20 flex items-center gap-2">
                      💾 Lưu
                    </button>
                    <button onClick={() => setEditing(false)}
                      className="px-5 py-2.5 bg-white/15 backdrop-blur-sm text-white rounded-2xl hover:bg-white/25 transition-all border border-white/20">
                      Hủy
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => setEditing(true)}
                      className="px-5 py-2.5 bg-white/15 backdrop-blur-sm hover:bg-white/25 text-white rounded-2xl transition-all border border-white/20 text-sm font-semibold flex items-center gap-1.5">
                      ✏️ Chỉnh sửa
                    </button>
                    <button
                      onClick={() => setShareModalOpen(true)}
                      className="px-5 py-2.5 bg-orange-500/25 backdrop-blur-sm hover:bg-orange-500/40 text-orange-100 hover:text-white rounded-2xl transition-all border border-orange-300/30 text-sm font-semibold flex items-center gap-1.5"
                    >
                      💬 Chia sẻ
                    </button>
                    <button
                      onClick={handleExportPDF}
                      disabled={isExportingPdf}
                      className="px-5 py-2.5 bg-emerald-500/20 backdrop-blur-sm hover:bg-emerald-500/35 text-emerald-200 hover:text-white rounded-2xl transition-all border border-emerald-400/30 text-sm font-semibold flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {isExportingPdf ? <><span className="animate-spin inline-block">⚙️</span> Đang xuất...</> : '📄 Xuất PDF'}
                    </button>
                    <button onClick={handleDelete}
                      className="px-5 py-2.5 bg-red-500/20 backdrop-blur-sm hover:bg-red-500/40 text-red-200 hover:text-white rounded-2xl transition-all border border-red-400/30 text-sm font-semibold flex items-center gap-1.5">
                      🗑️ Xóa
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Editing fields */}
            {editing && (
              <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3">
                <textarea
                  value={editData.description}
                  onChange={e => setEditData({ ...editData, description: e.target.value })}
                  placeholder="Mô tả lịch trình..."
                  rows={2}
                  className="md:col-span-2 px-4 py-3 bg-white/15 backdrop-blur-sm text-white placeholder-white/40 rounded-2xl resize-none outline-none border border-white/20 text-sm"
                />
                <select
                  value={editData.status}
                  onChange={e => setEditData({ ...editData, status: e.target.value })}
                  className="px-4 py-3 bg-white/15 backdrop-blur-sm text-white rounded-2xl outline-none border border-white/20 text-sm appearance-none"
                >
                  {statusOptions.map(s => <option key={s.value} value={s.value} className="text-gray-900 bg-white">{s.label}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>

        {/* ── WEATHER PANEL ── */}
        {weatherData && (
          <div className="max-w-5xl mx-auto px-4 mt-6">
            <div className={`rounded-3xl border-2 px-6 py-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-lg relative overflow-hidden ${
              weatherData.status === 'storm'
                ? 'bg-gradient-to-r from-red-50 to-rose-50 border-red-300'
                : weatherData.status === 'rain'
                ? 'bg-gradient-to-r from-amber-50 to-yellow-50 border-amber-300'
                : 'bg-gradient-to-r from-emerald-50 to-green-50 border-emerald-300'
            }`}>
              {/* Animated background pattern */}
              <div className="absolute inset-0 opacity-5">
                <div className="absolute top-0 left-0 w-32 h-32 bg-current rounded-full blur-3xl animate-pulse" />
                <div className="absolute bottom-0 right-0 w-40 h-40 bg-current rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
              </div>

              <div className="relative flex items-center gap-4">
                <div className={`w-16 h-16 rounded-2xl flex items-center justify-center text-4xl shadow-lg ${
                  weatherData.status === 'storm' ? 'bg-red-100' : weatherData.status === 'rain' ? 'bg-amber-100' : 'bg-emerald-100'
                }`}>
                  {weatherData.status === 'storm' ? '🌩️' : weatherData.status === 'rain' ? '🌧️' : '☀️'}
                </div>
                <div>
                  <p className={`font-black text-base mb-1 ${
                    weatherData.status === 'storm' ? 'text-red-700' : weatherData.status === 'rain' ? 'text-amber-700' : 'text-emerald-700'
                  }`}>
                    {weatherData.status === 'storm' ? '⚠️ Cảnh báo thời tiết xấu' : weatherData.status === 'rain' ? '🌂 Lưu ý có mưa' : '✅ Thời tiết thuận lợi'}
                  </p>
                  <p className="text-sm text-gray-600 font-medium">{weatherData.description}</p>
                </div>
              </div>

              <div className="relative flex items-center gap-3 flex-wrap">
                {weatherData.days.slice(0, 5).map(d => (
                  <div key={d.date} className="flex flex-col items-center text-center bg-white/80 backdrop-blur-sm rounded-2xl px-3 py-2 border-2 border-white shadow-md hover:scale-105 transition-transform">
                    <span className="text-xs text-gray-600 font-semibold mb-1">{new Date(d.date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}</span>
                    <span className="text-2xl mb-1">
                      {d.code >= 95 ? '⛈️' : d.code >= 80 ? '🌨️' : d.code >= 61 ? '🌧️' : d.code >= 51 ? '🌦️' : d.code >= 2 ? '⛅' : '☀️'}
                    </span>
                    <span className="text-xs font-bold text-sky-600">{d.precip > 0 ? `${d.precip}mm` : '0mm'}</span>
                  </div>
                ))}
                {weatherData.status !== 'ok' && (
                  <Link
                    href={`/ai-chat?q=${encodeURIComponent(`Lịch trình ${itinerary.title} bị ${weatherData.status === 'storm' ? 'dông bão' : 'mưa'}, gợi ý các hoạt động trong nhà hoặc phương án thay thế`)}`}
                    className="ml-2 px-5 py-2.5 bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 text-white text-sm font-bold rounded-xl transition-all shadow-lg hover:shadow-xl hover:scale-105"
                  >
                    🤖 Hỏi AI phương án B
                  </Link>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="max-w-5xl mx-auto px-4 mt-8">
          {dests.length === 0 ? (
            /* Empty state */
            <div className="relative rounded-3xl overflow-hidden shadow-xl"
              style={{ background: 'linear-gradient(135deg, #86efac 0%, #4ade80 30%, #22c55e 60%, #16a34a 100%)', minHeight: 400 }}>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-8">
                <div className="text-8xl mb-6 animate-bounce">🧭</div>
                <h3 className="text-2xl font-bold text-white text-shadow mb-3">Bản đồ hành trình trống!</h3>
                <p className="text-white/80 mb-6">Thêm điểm đến để bắt đầu hành trình của bạn</p>
                <Link href="/destinations" className="px-6 py-3 bg-white text-green-700 font-bold rounded-2xl hover:scale-105 transition-transform shadow-lg">
                  + Thêm điểm đến
                </Link>
              </div>
            </div>
          ) : (
            <div className="flex flex-col lg:flex-row gap-6">
              {/* ── LEFT: Game Map / Live Map (40% width) ── */}
              <div className="lg:w-[40%]">
                <div className="lg:sticky lg:top-24">
                <div>
                {/* ── Header: tiêu đề + nút mở trang dẫn đường riêng ── */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                      🗺️ <span>Bản đồ hành trình</span>
                    </h2>
                    <p className="text-xs text-gray-500 mt-1">Click vào điểm để xem chi tiết</p>
                  </div>
                  <button
                    onClick={() => {
                      saveNavPayload({
                        title: itinerary.title,
                        waypoints: displayDests.map((d) => ({
                          name: d.destination?.name ?? '',
                          city: d.destination?.location?.city,
                          lat: d.destination?.location?.coordinates?.lat,
                          lng: d.destination?.location?.coordinates?.lng,
                        })),
                      });
                      router.push('/navigate');
                    }}
                    className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-md hover:shadow-lg hover:scale-[1.02] transition-all active:scale-100"
                  >
                    🧭 <span className="hidden sm:inline">Dẫn đường thực tế</span><span className="sm:hidden">Dẫn đường</span>
                  </button>
                </div>

                <div className="rounded-2xl overflow-hidden shadow-xl border border-gray-100">
                  <ItineraryMap
                    dests={dests}
                    displayDests={displayDests}
                    activeNode={activeNode}
                    onNodeClick={setActiveNode}
                  />
                </div>

                {/* Add destination shortcut */}
                {!readOnly && (
                  <div className="mt-3 text-center">
                    <Link
                      href="/destinations"
                      className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-xl hover:shadow-lg hover:shadow-green-500/30 transition-all hover:scale-105 text-sm"
                    >
                      + Thêm điểm đến
                    </Link>
                  </div>
                )}
                </div>
                </div>
              </div>

              {/* ── RIGHT: Info Panel (60% width) ── */}
              <div className="lg:w-[60%]">
                {/* ── OVERVIEW STATS CARDS ── */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                  {/* Total Destinations */}
                  <div className="bg-gradient-to-br from-sky-50 to-blue-50 border border-sky-200 rounded-2xl p-4 hover:shadow-md transition-shadow">
                    <div className="text-2xl mb-1">📍</div>
                    <div className="text-2xl font-black text-sky-700">{dests.length}</div>
                    <div className="text-xs text-sky-600 font-medium">Điểm đến</div>
                  </div>

                  {/* Days */}
                  <div className="bg-gradient-to-br from-violet-50 to-purple-50 border border-violet-200 rounded-2xl p-4 hover:shadow-md transition-shadow">
                    <div className="text-2xl mb-1">🗓️</div>
                    <div className="text-2xl font-black text-violet-700">{getDayCount()}</div>
                    <div className="text-xs text-violet-600 font-medium">Ngày</div>
                  </div>

                  {/* Estimated Travel Time */}
                  <div className="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-4 hover:shadow-md transition-shadow">
                    <div className="text-2xl mb-1">⏱️</div>
                    <div className="text-2xl font-black text-amber-700">{Math.round(dests.length * 0.5 * 10) / 10}h</div>
                    <div className="text-xs text-amber-600 font-medium">Di chuyển</div>
                  </div>

                  {/* Budget */}
                  <div className="bg-gradient-to-br from-emerald-50 to-green-50 border border-emerald-200 rounded-2xl p-4 hover:shadow-md transition-shadow">
                    <div className="text-2xl mb-1">💰</div>
                    <div className="text-lg font-black text-emerald-700">
                      {itinerary.budget?.estimated ? `${(itinerary.budget.estimated / 1000000).toFixed(1)}M` : '—'}
                    </div>
                    <div className="text-xs text-emerald-600 font-medium">Ngân sách</div>
                  </div>
                </div>
                {activeNode === null ? (
                  /* Default: show all destinations list with modern timeline design */
                  <div>
                    <div className="flex items-center justify-between mb-6">
                      <div>
                        <h2 className="text-2xl font-black text-gray-800 flex items-center gap-2 mb-1">
                          🗺️ <span>Lộ trình chi tiết</span>
                        </h2>
                        <p className="text-sm text-gray-500">Đã tối ưu theo đường đi ngắn nhất</p>
                      </div>
                      <button
                        onClick={handleOptimize}
                        disabled={isOptimizing || dests.length < 2 || readOnly}
                        className="flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-violet-500 to-purple-600 text-white text-sm font-bold rounded-2xl hover:shadow-xl hover:shadow-violet-500/30 transition-all hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                        title={readOnly ? 'Chỉ chủ lịch trình mới có thể tối ưu' : 'Tự động sắp xếp lại thứ tự trạm dừng theo đường đi ngắn nhất'}
                      >
                        {isOptimizing ? (
                          <><span className="animate-spin text-lg">⚙️</span> <span>Đang tối ưu...</span></>
                        ) : (
                          <><span className="text-lg">🪄</span> <span>Tối ưu lại</span></>
                        )}
                      </button>
                    </div>

                    {/* Toast thông báo kết quả optimize */}
                    {optimizeMsg && (
                      <div className="mb-6 flex items-center gap-3 bg-gradient-to-r from-emerald-50 to-green-50 border-2 border-emerald-300 text-emerald-700 text-sm font-semibold px-6 py-4 rounded-2xl animate-in fade-in slide-in-from-top-2 duration-300 shadow-lg">
                        <span className="text-2xl">✅</span>
                        <span>{optimizeMsg}</span>
                      </div>
                    )}

                    {/* Timeline-style route list */}
                    <div className="relative">
                      {/* Vertical timeline line */}
                      <div className="absolute left-8 top-0 bottom-0 w-1 bg-gradient-to-b from-green-400 via-sky-400 to-red-400 rounded-full" />

                      <div className="space-y-4">
                        {(() => {
                          const rawStops = dests.map(d => d.destination).filter(Boolean) as Destination[];
                          const sortedStops = nearestNeighborSort(rawStops);

                          return sortedStops.map((dest, idx) => {
                            const icon = categoryIcons[dest?.category] || categoryIcons.default;
                            const originalIdx = dests.findIndex(d => d.destination?._id === dest._id);

                            // Calculate distance to next stop
                            const nextDest = sortedStops[idx + 1];
                            const distToNext = (() => {
                              if (!nextDest || !dest?.location?.coordinates?.lat || !nextDest?.location?.coordinates?.lat) return null;
                              const d = haversine(
                                dest.location.coordinates!.lat!, dest.location.coordinates!.lng!,
                                nextDest.location.coordinates!.lat!, nextDest.location.coordinates!.lng!
                              );
                              return d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`;
                            })();

                            const isFirst = idx === 0;
                            const isLast = idx === sortedStops.length - 1;

                            return (
                              <div key={`${dest._id}-${idx}`} className="relative">
                                {/* Timeline node */}
                                <div className={`absolute left-8 -translate-x-1/2 w-8 h-8 rounded-full flex items-center justify-center font-black text-sm shadow-lg z-10 ${
                                  isFirst ? 'bg-gradient-to-br from-green-400 to-emerald-600 text-white ring-4 ring-green-200' :
                                  isLast ? 'bg-gradient-to-br from-red-400 to-rose-600 text-white ring-4 ring-red-200' :
                                  'bg-gradient-to-br from-sky-400 to-blue-600 text-white ring-4 ring-sky-200'
                                }`}>
                                  {isFirst ? '🚀' : isLast ? '🏁' : idx + 1}
                                </div>

                                {/* Card */}
                                <button
                                  onClick={() => setActiveNode(originalIdx)}
                                  className="w-full ml-16 flex items-center gap-4 p-5 bg-white rounded-2xl shadow-md hover:shadow-2xl border-2 border-gray-100 hover:border-sky-300 transition-all text-left group relative overflow-hidden"
                                >
                                  {/* Gradient overlay on hover */}
                                  <div className="absolute inset-0 bg-gradient-to-r from-sky-50 via-blue-50 to-violet-50 opacity-0 group-hover:opacity-100 transition-opacity" />

                                  {/* Thumbnail */}
                                  <div className="relative w-20 h-20 shrink-0 rounded-2xl overflow-hidden shadow-lg ring-2 ring-white group-hover:ring-sky-300 transition-all group-hover:scale-105">
                                    {dest?.images?.[0] ? (
                                      <Image src={dest.images[0]} alt={dest.name || ''} fill className="object-cover" />
                                    ) : (
                                      <div className="w-full h-full bg-gradient-to-br from-sky-100 to-blue-200 flex items-center justify-center text-4xl">{icon}</div>
                                    )}
                                  </div>

                                  {/* Info */}
                                  <div className="relative flex-1 min-w-0">
                                    <div className="flex items-start justify-between gap-3 mb-2">
                                      <div className="flex-1 min-w-0">
                                        <h3 className="font-black text-gray-900 group-hover:text-sky-600 transition-colors text-lg leading-tight mb-1">
                                          {dest?.name}
                                        </h3>
                                        <p className="text-sm text-gray-500 flex items-center gap-1.5">
                                          <span className="text-base">📍</span>
                                          <span>{dest?.location?.city}, {dest?.location?.country}</span>
                                        </p>
                                      </div>
                                      {isFirst && (
                                        <span className="shrink-0 px-3 py-1 bg-green-100 text-green-700 text-xs font-bold rounded-full border border-green-300">
                                          Điểm xuất phát
                                        </span>
                                      )}
                                      {isLast && (
                                        <span className="shrink-0 px-3 py-1 bg-red-100 text-red-700 text-xs font-bold rounded-full border border-red-300">
                                          Điểm kết thúc
                                        </span>
                                      )}
                                    </div>

                                    <div className="flex items-center gap-3 flex-wrap">
                                      {/* Rating */}
                                      <div className="flex items-center gap-1.5 bg-amber-50 px-3 py-1.5 rounded-xl border border-amber-200">
                                        <div className="flex items-center">
                                          {renderStars(dest?.rating || 0)}
                                        </div>
                                        <span className="text-sm text-amber-700 font-bold">{dest?.rating?.toFixed(1)}</span>
                                      </div>

                                      {/* Category */}
                                      <span className="px-3 py-1.5 bg-sky-50 text-sky-700 text-xs font-semibold rounded-xl border border-sky-200">
                                        {icon} {dest?.category || 'Địa điểm'}
                                      </span>

                                      {/* Distance to next */}
                                      {distToNext && !isLast && (
                                        <span className="px-3 py-1.5 bg-violet-50 text-violet-700 text-xs font-bold rounded-xl border border-violet-200 flex items-center gap-1">
                                          <span>→</span> {distToNext} <span className="text-violet-400">•</span> ~30min
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  {/* Arrow */}
                                  <span className="relative text-gray-300 group-hover:text-sky-500 text-3xl transition-colors shrink-0">→</span>
                                </button>

                                {/* Connector info between stops */}
                                {!isLast && distToNext && (
                                  <div className="ml-16 mt-3 mb-1 flex items-center gap-3 text-sm text-gray-500">
                                    <div className="w-12 h-0.5 bg-gradient-to-r from-sky-300 to-blue-400 rounded-full" />
                                    <span className="font-medium">Di chuyển: {distToNext} • Thời gian: ~30 phút</span>
                                  </div>
                                )}
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Detail panel for selected node */
                  (() => {
                    const item = dests[activeNode];
                    const dest = item?.destination;
                    const icon = categoryIcons[dest?.category] || categoryIcons.default;
                    return (
                      <div className="bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100 animate-in fade-in slide-in-from-right-4 duration-300">
                        {/* Image hero */}
                        <div className="relative h-56">
                          {dest?.images?.[0] ? (
                            <Image src={dest.images[0]} alt={dest.name || ''} fill className="object-cover" />
                          ) : (
                            <div className="w-full h-full bg-gradient-to-br from-sky-200 to-blue-400 flex items-center justify-center text-6xl">{icon}</div>
                          )}
                          {/* Overlay gradient */}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />

                          {/* Back button */}
                          <button
                            onClick={() => setActiveNode(null)}
                            className="absolute top-4 left-4 w-9 h-9 bg-white/90 backdrop-blur-sm rounded-full flex items-center justify-center text-gray-700 hover:bg-white transition-all shadow-md"
                          >
                            ←
                          </button>

                          {/* Node badge */}
                          <div className="absolute top-4 right-4 w-12 h-12 bg-gradient-to-br from-sky-400 to-blue-600 rounded-full flex items-center justify-center text-white font-black text-xl shadow-lg ring-3 ring-white">
                            {activeNode + 1}
                          </div>

                          {/* Title on image */}
                          <div className="absolute bottom-4 left-4 right-4">
                            <h3 className="text-2xl font-extrabold text-white drop-shadow-lg">{dest?.name}</h3>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-white/90 text-sm">📍 {dest?.location?.city}, {dest?.location?.country}</span>
                            </div>
                          </div>
                        </div>

                        {/* Content */}
                        <div className="p-5">
                          {/* Ratings & Category */}
                          <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-2">
                              <div className="flex">{renderStars(dest?.rating || 0)}</div>
                              <span className="text-sm font-bold text-gray-700">{dest?.rating?.toFixed(1)}</span>
                            </div>
                            <span className="px-3 py-1 bg-sky-50 text-sky-700 rounded-full text-sm font-semibold border border-sky-100">
                              {icon} {dest?.category || 'Địa điểm'}
                            </span>
                          </div>

                          {/* Notes from AI / user */}
                          {item.notes && (
                            <div className="mb-4 bg-gradient-to-r from-violet-50 to-sky-50 border border-violet-100 rounded-2xl p-4 relative">
                              <div className="absolute -top-2.5 left-4 bg-violet-100 text-violet-600 text-xs font-bold px-2 py-0.5 rounded-full">🤖 Ghi chú AI</div>
                              <p className="text-gray-700 text-sm leading-relaxed italic mt-1">"{item.notes}"</p>
                            </div>
                          )}

                          {/* Activities */}
                          {item.activities && item.activities.length > 0 && (
                            <div className="mb-4">
                              <p className="text-sm font-bold text-gray-600 mb-2">✨ Hoạt động gợi ý:</p>
                              <div className="flex flex-wrap gap-2">
                                {item.activities.map((act, i) => (
                                  <span key={i} className="px-3 py-1.5 bg-gradient-to-r from-sky-50 to-blue-50 border border-sky-200 text-sky-700 rounded-xl text-xs font-semibold shadow-sm">
                                    {act}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Navigation between stops */}
                          <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-100">
                            <button
                              onClick={() => setActiveNode(Math.max(0, activeNode - 1))}
                              disabled={activeNode === 0}
                              className="px-4 py-2 bg-gray-100 text-gray-600 rounded-xl hover:bg-gray-200 transition-all disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium"
                            >
                              ← Trạm trước
                            </button>

                            <div className="flex gap-2">
                              <Link
                                href={`/destinations/${dest?._id}`}
                                className="px-4 py-2 bg-sky-500 text-white rounded-xl hover:bg-sky-600 transition-all text-sm font-semibold shadow-sm"
                              >
                                Xem chi tiết
                              </Link>
                              {!readOnly && (
                                <button
                                  onClick={() => handleRemoveDestination(dest?._id)}
                                  className="px-3 py-2 bg-red-50 text-red-500 rounded-xl hover:bg-red-100 transition-all text-sm"
                                  title="Xóa khỏi lịch trình"
                                >
                                  🗑️
                                </button>
                              )}
                            </div>

                            <button
                              onClick={() => setActiveNode(Math.min(dests.length - 1, activeNode + 1))}
                              disabled={activeNode === dests.length - 1}
                              className="px-4 py-2 bg-gray-100 text-gray-600 rounded-xl hover:bg-gray-200 transition-all disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium"
                            >
                              Trạm sau →
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>
            </div>
          )}

          {/* ── AI ITINERARY NOTES ── */}
          {itinerary.description && (
            <DescriptionPanel description={itinerary.description} />
          )}
        </div>
      </div>

      <Footer />

      <ShareItineraryModal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        preselectedItineraryId={itinerary?._id}
      />

      {/* ── HIDDEN PDF EXPORT CONTENT ── */}
      <div id="pdf-export-content" className="hidden" style={{ fontFamily: 'Arial, sans-serif', background: '#fff', padding: '32px', width: '794px', boxSizing: 'border-box', color: '#0f172a' }}>
        {/* Header */}
        <div style={{ background: 'linear-gradient(135deg, #0ea5e9, #7c3aed)', borderRadius: 16, padding: '22px 26px', marginBottom: 18, color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6, letterSpacing: 2 }}>TRAVELAI — LỊCH TRÌNH DU LỊCH</div>
          <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 10, lineHeight: 1.3, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{itinerary?.title}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', fontSize: 13, opacity: 0.95 }}>
            <span>📅 {new Date(itinerary?.startDate || '').toLocaleDateString('vi-VN')} → {new Date(itinerary?.endDate || '').toLocaleDateString('vi-VN')}</span>
            <span>🗓️ {getDayCount()} ngày</span>
            <span>📍 {itinerary?.destinations?.length} điểm đến</span>
            {itinerary?.budget?.estimated ? <span>💰 Ngân sách ~{(itinerary.budget.estimated / 1000000).toFixed(1)} triệu</span> : null}
          </div>
        </div>

        {/* Thời tiết */}
        {weatherData && (
          <div style={{
            marginBottom: 16, padding: '10px 14px', borderRadius: 10,
            background: weatherData.status === 'storm' ? '#fef2f2' : weatherData.status === 'rain' ? '#fffbeb' : '#ecfdf5',
            border: `1px solid ${weatherData.status === 'storm' ? '#fecaca' : weatherData.status === 'rain' ? '#fde68a' : '#a7f3d0'}`,
            color: weatherData.status === 'storm' ? '#dc2626' : weatherData.status === 'rain' ? '#d97706' : '#059669',
            fontSize: 13, fontWeight: 600,
          }}>
            {weatherData.status === 'storm' ? '🌩️' : weatherData.status === 'rain' ? '🌧️' : '☀️'} Thời tiết: {weatherData.description}
          </div>
        )}

        {/* Destinations */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#334155', marginBottom: 10, borderBottom: '2px solid #e2e8f0', paddingBottom: 7 }}>
            🗺️ Hành trình chi tiết
          </div>
          {itinerary?.destinations?.map((item, idx) => {
            const d = item.destination;
            const loc = [d?.location?.city, d?.location?.country].filter(Boolean).join(', ');
            const stars = Math.floor(d?.rating || 0);
            return (
              <div key={idx} style={{ display: 'flex', gap: 12, marginBottom: 8, padding: '10px 12px', background: idx % 2 === 0 ? '#f8fafc' : '#fff', borderRadius: 10, border: '1px solid #e2e8f0', breakInside: 'avoid' }}>
                <div style={{ width: 30, height: 30, background: 'linear-gradient(135deg, #38bdf8, #3b82f6)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 900, fontSize: 14, flexShrink: 0 }}>
                  {idx + 1}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#1e293b' }}>{d?.name}</div>
                    {d?.category && (
                      <div style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, color: '#475569', background: '#e2e8f0', borderRadius: 6, padding: '2px 7px', textTransform: 'uppercase' }}>
                        {d.category}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 12, fontSize: 11.5, marginTop: 3 }}>
                    {loc && <span style={{ color: '#64748b' }}>📍 {loc}</span>}
                    {d?.rating ? <span style={{ color: '#f59e0b' }}>{'★'.repeat(stars)}{'☆'.repeat(5 - stars)} {d.rating.toFixed(1)}</span> : null}
                  </div>
                  {d?.description && (
                    <div style={{ fontSize: 11.5, color: '#475569', marginTop: 5, lineHeight: 1.5 }}>{d.description}</div>
                  )}
                  {item.notes && (
                    <div style={{ fontSize: 11.5, color: '#0369a1', marginTop: 5, fontStyle: 'italic' }}>“{item.notes}”</div>
                  )}
                  {item.activities && item.activities.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
                      {item.activities.map((act, i) => (
                        <span key={i} style={{ fontSize: 10.5, color: '#0e7490', background: '#ecfeff', border: '1px solid #a5f3fc', borderRadius: 999, padding: '2px 8px' }}>✓ {act}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Kế hoạch chi tiết từ AI (Markdown) */}
        {itinerary?.description && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#334155', marginBottom: 10, borderBottom: '2px solid #e2e8f0', paddingBottom: 7 }}>
              🤖 Kế hoạch chi tiết
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.65, color: '#475569' }}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => <div style={{ fontSize: 16, fontWeight: 800, color: '#0369a1', margin: '14px 0 6px' }}>{children}</div>,
                  h2: ({ children }) => <div style={{ fontSize: 15, fontWeight: 800, color: '#0369a1', margin: '14px 0 6px' }}>{children}</div>,
                  h3: ({ children }) => <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0e7490', margin: '12px 0 5px' }}>{children}</div>,
                  p: ({ children }) => <p style={{ margin: '5px 0' }}>{children}</p>,
                  ul: ({ children }) => <ul style={{ margin: '5px 0', paddingLeft: 18 }}>{children}</ul>,
                  ol: ({ children }) => <ol style={{ margin: '5px 0', paddingLeft: 18 }}>{children}</ol>,
                  li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
                  strong: ({ children }) => <strong style={{ fontWeight: 700, color: '#1e293b' }}>{children}</strong>,
                  hr: () => <hr style={{ border: 'none', borderTop: '1px solid #e2e8f0', margin: '12px 0' }} />,
                  table: ({ children }) => <table style={{ width: '100%', borderCollapse: 'collapse', margin: '8px 0', fontSize: 11.5, breakInside: 'avoid' }}>{children}</table>,
                  thead: ({ children }) => <thead style={{ background: '#f0f9ff' }}>{children}</thead>,
                  th: ({ children }) => <th style={{ border: '1px solid #e2e8f0', padding: '5px 8px', textAlign: 'left', fontWeight: 700, color: '#0369a1' }}>{children}</th>,
                  td: ({ children }) => <td style={{ border: '1px solid #e2e8f0', padding: '5px 8px', verticalAlign: 'top' }}>{children}</td>,
                }}
              >
                {itinerary.description}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {/* Google Maps QR */}
        <div style={{ marginBottom: 18, padding: '14px 16px', background: '#f0f9ff', borderRadius: 10, border: '1px solid #bae6fd', display: 'flex', alignItems: 'center', gap: 14 }}>
          <img
            src={`https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(
              (() => {
                const validDests = itinerary?.destinations
                  ?.filter(d => d.destination?.location?.coordinates?.lat != null && d.destination?.location?.coordinates?.lng != null) || [];

                if (validDests.length === 0) return 'https://maps.google.com';
                if (validDests.length === 1) {
                  const d = validDests[0].destination!;
                  return `https://www.google.com/maps/search/?api=1&query=${d.location!.coordinates!.lat},${d.location!.coordinates!.lng}`;
                }

                const origin = `${validDests[0].destination!.location!.coordinates!.lat},${validDests[0].destination!.location!.coordinates!.lng}`;
                const destination = `${validDests[validDests.length - 1].destination!.location!.coordinates!.lat},${validDests[validDests.length - 1].destination!.location!.coordinates!.lng}`;
                const waypoints = validDests.slice(1, -1).map(d =>
                  `${d.destination!.location!.coordinates!.lat},${d.destination!.location!.coordinates!.lng}`
                );

                let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
                if (waypoints.length > 0) {
                  url += `&waypoints=${waypoints.join('|')}`;
                }
                return url;
              })()
            )}`}
            alt="QR Google Maps" width={80} height={80} style={{ borderRadius: 8 }} crossOrigin="anonymous"
          />
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: '#0369a1' }}>📱 Quét QR để mở Google Maps</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Dẫn đường tất cả {itinerary?.destinations?.length} điểm trong hành trình</div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>Được tạo bởi TravelAI — Trợ lý du lịch thông minh Việt Nam</span>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>{new Date().toLocaleDateString('vi-VN')}</span>
        </div>
      </div>
    </div>
  );
}
