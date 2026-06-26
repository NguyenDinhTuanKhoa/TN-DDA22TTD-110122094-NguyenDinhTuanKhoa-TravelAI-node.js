'use client';
import { useState, useEffect } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { useAuth } from '../context/AuthContext';
import { getSavedTours, removeSavedTour, SAVED_TOURS_EVENT, type SavedTour } from '../lib/savedTours';
import { useTourStatus, setTourStatus } from '../lib/tourProgress';
import TourDetailModal from '../components/TourDetailModal';

interface Destination {
  _id: string;
  name: string;
  images: string[];
  location: { city: string; country: string };
  category: string;
  rating: number;
  priceRange: string;
}

interface Itinerary {
  _id: string;
  title: string;
  startDate: string;
  endDate: string;
  status: string;
  destinations: { destination: Destination }[];
}

const categoryLabels: Record<string, string> = {
  beach: '🏖️ Biển',
  mountain: '🏔️ Núi',
  city: '🌆 Thành phố',
  countryside: '🌾 Nông thôn',
  historical: '🏛️ Di tích',
};

// Card tour đã lưu kèm vòng đời (badge trạng thái + nút hành động). Tách riêng
// để gọi hook useTourStatus cho từng tour (không gọi hook trong .map của cha).
function SavedTourCard({
  tour,
  onOpen,
  onRemove,
}: {
  tour: SavedTour;
  onOpen: (tab: 'map' | 'reviews') => void;
  onRemove: () => void;
}) {
  const status = useTourStatus(tour.id);
  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-lg transition-all group">
      <button onClick={() => onOpen('map')} className="block w-full text-left">
        <div className="relative h-48">
          <Image
            src={tour.coverImage || 'https://via.placeholder.com/400'}
            alt={tour.title}
            fill
            className="object-cover group-hover:scale-105 transition-transform"
          />
          <span className="absolute top-3 left-3 px-2 py-1 bg-white/90 backdrop-blur-sm rounded-full text-xs font-medium">
            ⭐ {tour.rating?.toFixed(1)}
          </span>
          {status !== 'saved' && (
            <span
              className={`absolute top-3 right-3 px-2 py-1 rounded-full text-xs font-bold backdrop-blur-sm ${
                status === 'completed' ? 'bg-emerald-500/90 text-white' : 'bg-amber-400/95 text-white'
              }`}
            >
              {status === 'completed' ? '✓ Đã đi' : '🚶 Đang đi'}
            </span>
          )}
          <span className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-black/55 group-hover:bg-black/75 backdrop-blur text-white text-xs font-semibold transition-all">
            👁️ Xem chi tiết
          </span>
        </div>
      </button>
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <button onClick={() => onOpen('map')} className="flex-1 min-w-0 text-left">
            <h3 className="font-semibold text-gray-900 line-clamp-2 hover:text-sky-600 transition-colors">
              <span className="mr-1">{tour.categoryIcon}</span>{tour.title}
            </h3>
            <p className="text-sm text-gray-500 mt-1">📍 {tour.region} · ⏱️ {tour.duration}</p>
            <p className="text-orange-600 font-bold mt-1">{tour.priceLabel}</p>
          </button>
          <button
            onClick={onRemove}
            className="p-2 text-red-500 hover:bg-red-50 rounded-full transition-all flex-shrink-0"
            title="Bỏ lưu"
          >
            ❤️
          </button>
        </div>

        {/* Hành động theo vòng đời */}
        <div className="mt-3">
          {status === 'completed' ? (
            <button
              onClick={() => onOpen('reviews')}
              className="w-full py-2.5 rounded-xl bg-amber-100 text-amber-700 font-bold text-sm hover:bg-amber-200 transition-all"
            >
              ⭐ Đánh giá
            </button>
          ) : status === 'going' ? (
            <button
              onClick={() => { setTourStatus(tour.id, 'completed'); onOpen('reviews'); }}
              className="w-full py-2.5 rounded-xl bg-emerald-500 text-white font-bold text-sm hover:bg-emerald-600 transition-all"
            >
              Đã đi xong
            </button>
          ) : (
            <button
              onClick={() => onOpen('map')}
              className="w-full py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-sky-500 text-white font-bold text-sm hover:shadow-md transition-all"
            >
              ▶ Bắt đầu đi
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SavedPage() {
  const router = useRouter();
  const { user, token, loading: authLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<'saved' | 'tours' | 'itineraries'>('saved');
  const [savedDestinations, setSavedDestinations] = useState<Destination[]>([]);
  const [savedTours, setSavedTours] = useState<SavedTour[]>([]);
  const [selectedTour, setSelectedTour] = useState<SavedTour | null>(null);
  const [modalTab, setModalTab] = useState<'map' | 'reviews'>('map');
  const [itineraries, setItineraries] = useState<Itinerary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push('/login');
      return;
    }
    loadData();
  }, [user, authLoading]);

  // Saved tours sống trong localStorage (tour cộng đồng không nằm trong DB)
  useEffect(() => {
    const sync = () => setSavedTours(getSavedTours());
    sync();
    window.addEventListener(SAVED_TOURS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(SAVED_TOURS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // Khóa cuộn nền khi đang mở modal chi tiết tour
  useEffect(() => {
    document.body.style.overflow = selectedTour ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [selectedTour]);

  const loadData = async () => {
    const savedToken = localStorage.getItem('token');
    if (!savedToken) return;

    setLoading(true);
    try {
      // Load saved destinations
      const savedRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/saved`, {
        headers: { Authorization: `Bearer ${savedToken}` }
      });
      const savedData = await savedRes.json();
      if (savedData.success) {
        setSavedDestinations(savedData.data);
      }

      // Load itineraries
      const itinRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/itineraries`, {
        headers: { Authorization: `Bearer ${savedToken}` }
      });
      const itinData = await itinRes.json();
      if (itinData.success) {
        setItineraries(itinData.data);
      }
    } catch (error) {
      console.error('Error loading data:', error);
    }
    setLoading(false);
  };


  const handleUnsave = async (destId: string) => {
    const savedToken = localStorage.getItem('token');
    if (!savedToken) return;

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/saved/${destId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${savedToken}` }
      });
      const data = await res.json();
      if (data.success && !data.data.saved) {
        setSavedDestinations(prev => prev.filter(d => d._id !== destId));
      }
    } catch (error) {
      console.error('Error unsaving:', error);
    }
  };

  const handleDeleteItinerary = async (itinId: string) => {
    if (!confirm('Bạn có chắc muốn xóa lịch trình này?')) return;
    
    const savedToken = localStorage.getItem('token');
    if (!savedToken) return;

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/itineraries/${itinId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${savedToken}` }
      });
      const data = await res.json();
      if (data.success) {
        setItineraries(prev => prev.filter(i => i._id !== itinId));
      }
    } catch (error) {
      console.error('Error deleting itinerary:', error);
    }
  };

  const openTourDetail = (tour: SavedTour, tab: 'map' | 'reviews' = 'map') => {
    setModalTab(tab);
    setSelectedTour(tour);
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'planning': return { text: 'Đang lên kế hoạch', color: 'bg-yellow-100 text-yellow-700' };
      case 'ongoing': return { text: 'Đang diễn ra', color: 'bg-green-100 text-green-700' };
      case 'completed': return { text: 'Đã hoàn thành', color: 'bg-gray-100 text-gray-700' };
      default: return { text: status, color: 'bg-gray-100 text-gray-700' };
    }
  };

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      
      <div className="pt-24 pb-12">
        <div className="max-w-6xl mx-auto px-4">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">Của tôi</h1>
            <p className="text-gray-500 mt-1">Quản lý địa điểm đã lưu và lịch trình du lịch</p>
          </div>

          {/* Tabs */}
          <div className="flex gap-4 mb-8">
            <button
              onClick={() => setActiveTab('saved')}
              className={`px-6 py-3 rounded-xl font-medium transition-all ${
                activeTab === 'saved'
                  ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/30'
                  : 'bg-white text-gray-600 hover:bg-gray-100'
              }`}
            >
              ❤️ Đã lưu ({savedDestinations.length})
            </button>
            <button
              onClick={() => setActiveTab('tours')}
              className={`px-6 py-3 rounded-xl font-medium transition-all ${
                activeTab === 'tours'
                  ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/30'
                  : 'bg-white text-gray-600 hover:bg-gray-100'
              }`}
            >
              🧳 Tours đã lưu ({savedTours.length})
            </button>
            <button
              onClick={() => setActiveTab('itineraries')}
              className={`px-6 py-3 rounded-xl font-medium transition-all ${
                activeTab === 'itineraries'
                  ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/30'
                  : 'bg-white text-gray-600 hover:bg-gray-100'
              }`}
            >
              📅 Lịch trình ({itineraries.length})
            </button>
          </div>

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin w-10 h-10 border-4 border-sky-500 border-t-transparent rounded-full"></div>
            </div>
          ) : (
            <>
              {/* Saved Destinations Tab */}
              {activeTab === 'saved' && (
                <div>
                  {savedDestinations.length === 0 ? (
                    <div className="text-center py-12 bg-white rounded-2xl">
                      <p className="text-6xl mb-4">💔</p>
                      <p className="text-gray-500 mb-4">Chưa có địa điểm nào được lưu</p>
                      <Link href="/destinations" className="text-sky-500 hover:underline">
                        Khám phá điểm đến →
                      </Link>
                    </div>
                  ) : (
                    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {savedDestinations.map((dest) => (
                        <div key={dest._id} className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-lg transition-all group">
                          <Link href={`/destinations/${dest._id}`}>
                            <div className="relative h-48">
                              <Image
                                src={dest.images?.[0] || 'https://via.placeholder.com/400'}
                                alt={dest.name}
                                fill
                                className="object-cover group-hover:scale-105 transition-transform"
                              />
                              <span className="absolute top-3 left-3 px-2 py-1 bg-white/90 backdrop-blur-sm rounded-full text-xs font-medium">
                                {categoryLabels[dest.category] || dest.category}
                              </span>
                            </div>
                          </Link>
                          <div className="p-4">
                            <div className="flex items-start justify-between">
                              <div>
                                <h3 className="font-semibold text-gray-900">{dest.name}</h3>
                                <p className="text-sm text-gray-500">
                                  📍 {dest.location?.city}, {dest.location?.country}
                                </p>
                                <div className="flex items-center gap-1 mt-1 text-sm">
                                  <span className="text-yellow-400">★</span>
                                  <span className="text-gray-700">{dest.rating}</span>
                                </div>
                              </div>
                              <button
                                onClick={() => handleUnsave(dest._id)}
                                className="p-2 text-red-500 hover:bg-red-50 rounded-full transition-all"
                                title="Bỏ lưu"
                              >
                                ❤️
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}


              {/* Saved Tours Tab */}
              {activeTab === 'tours' && (
                <div>
                  {savedTours.length === 0 ? (
                    <div className="text-center py-12 bg-white rounded-2xl">
                      <p className="text-6xl mb-4">🧳</p>
                      <p className="text-gray-500 mb-4">Chưa có tour nào được lưu</p>
                      <Link href="/my-tours" className="text-sky-500 hover:underline">
                        Khám phá tours →
                      </Link>
                    </div>
                  ) : (
                    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {savedTours.map((tour) => (
                        <SavedTourCard
                          key={tour.id}
                          tour={tour}
                          onOpen={(tab) => openTourDetail(tour, tab)}
                          onRemove={() => removeSavedTour(tour.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}


              {/* Itineraries Tab */}
              {activeTab === 'itineraries' && (
                <div>
                  {itineraries.length === 0 ? (
                    <div className="text-center py-12 bg-white rounded-2xl">
                      <p className="text-6xl mb-4">📅</p>
                      <p className="text-gray-500 mb-4">Chưa có lịch trình nào</p>
                      <Link href="/destinations" className="text-sky-500 hover:underline">
                        Tạo lịch trình từ điểm đến →
                      </Link>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {itineraries.map((itin) => {
                        const status = getStatusLabel(itin.status);
                        return (
                          <div key={itin._id} className="bg-white rounded-2xl p-6 shadow-sm hover:shadow-md transition-all">
                            <div className="flex items-start justify-between mb-4">
                              <Link href={`/itinerary/${itin._id}`} className="flex-1">
                                <div className="flex items-center gap-3 mb-1">
                                  <h3 className="text-xl font-semibold text-gray-900 hover:text-sky-500">{itin.title}</h3>
                                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${status.color}`}>
                                    {status.text}
                                  </span>
                                </div>
                                <p className="text-gray-500">
                                  📅 {new Date(itin.startDate).toLocaleDateString('vi-VN')} - {new Date(itin.endDate).toLocaleDateString('vi-VN')}
                                </p>
                              </Link>
                              <div className="flex gap-2">
                                <Link
                                  href={`/itinerary/${itin._id}`}
                                  className="p-2 text-gray-400 hover:text-sky-500 hover:bg-sky-50 rounded-full transition-all"
                                  title="Xem chi tiết"
                                >
                                  👁️
                                </Link>
                                <button
                                  onClick={() => handleDeleteItinerary(itin._id)}
                                  className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-all"
                                  title="Xóa lịch trình"
                                >
                                  🗑️
                                </button>
                              </div>
                            </div>

                            {/* Destinations in itinerary */}
                            {itin.destinations.length > 0 ? (
                              <div className="flex flex-wrap gap-3">
                                {itin.destinations.map((item, idx) => (
                                  <Link
                                    key={idx}
                                    href={`/destinations/${item.destination?._id}`}
                                    className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg hover:bg-sky-50 transition-all"
                                  >
                                    {item.destination?.images?.[0] && (
                                      <Image
                                        src={item.destination.images[0]}
                                        alt={item.destination.name}
                                        width={32}
                                        height={32}
                                        className="w-8 h-8 rounded-full object-cover"
                                      />
                                    )}
                                    <span className="text-sm font-medium text-gray-700">
                                      {item.destination?.name || 'Điểm đến'}
                                    </span>
                                  </Link>
                                ))}
                              </div>
                            ) : (
                              <p className="text-gray-400 text-sm">Chưa có điểm đến nào</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Footer />

      {selectedTour && (
        <TourDetailModal
          tour={selectedTour}
          initialTab={modalTab}
          onClose={() => setSelectedTour(null)}
        />
      )}
    </div>
  );
}
