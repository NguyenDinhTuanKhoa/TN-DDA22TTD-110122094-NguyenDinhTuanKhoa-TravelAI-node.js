const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api';

async function fetchAdmin<T>(endpoint: string, options: RequestInit = {}): Promise<{ data?: T; error?: string }> {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;

    const res = await fetch(`${API_URL}/admin${endpoint}`, {
      ...options,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...options.headers,
      },
    });

    const data = await res.json();

    // Auto-logout on token expired
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
      return { error: data.message || 'Session expired' };
    }

    if (!res.ok) return { error: data.message || 'Error' };
    return { data };
  } catch (error) {
    return { error: 'Network error' };
  }
}


const qs = (params: Record<string, string | number | undefined | null>) => {
  const filtered = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return filtered.length ? `?${filtered.join('&')}` : '';
};

export const adminApi = {
  // ===== Stats =====
  getStats: (params: { days?: number } = {}) => fetchAdmin(`/stats${qs(params)}`),

  // ===== Global search =====
  globalSearch: (q: string) => fetchAdmin(`/search${qs({ q })}`),

  // ===== Notifications =====
  getNotifications: (since?: string) => fetchAdmin(`/notifications${qs({ since })}`),

  // ===== Users =====
  getUsers: (params: { page?: number; search?: string; role?: string; status?: string; dateFrom?: string; dateTo?: string } = {}) =>
    fetchAdmin(`/users${qs(params)}`),
  updateUserRole: (id: string, role: string) =>
    fetchAdmin(`/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
  banUser: (id: string, reason: string) =>
    fetchAdmin(`/users/${id}/ban`, { method: 'PUT', body: JSON.stringify({ reason }) }),
  unbanUser: (id: string) =>
    fetchAdmin(`/users/${id}/unban`, { method: 'PUT' }),
  deleteUser: (id: string) =>
    fetchAdmin(`/users/${id}`, { method: 'DELETE' }),
  bulkDeleteUsers: (ids: string[]) =>
    fetchAdmin('/users/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) }),

  // ===== Destinations =====
  getDestinations: (params: { page?: number; search?: string; category?: string; region?: string } = {}) =>
    fetchAdmin(`/destinations${qs(params)}`),
  createDestination: (data: object) =>
    fetchAdmin('/destinations', { method: 'POST', body: JSON.stringify(data) }),
  updateDestination: (id: string, data: object) =>
    fetchAdmin(`/destinations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDestination: (id: string) =>
    fetchAdmin(`/destinations/${id}`, { method: 'DELETE' }),
  bulkDeleteDestinations: (ids: string[]) =>
    fetchAdmin('/destinations/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) }),

  // ===== Reviews =====
  getReviews: (params: { page?: number; rating?: number; destinationId?: string; dateFrom?: string; dateTo?: string } = {}) =>
    fetchAdmin(`/reviews${qs(params)}`),
  deleteReview: (id: string) =>
    fetchAdmin(`/reviews/${id}`, { method: 'DELETE' }),
  bulkDeleteReviews: (ids: string[]) =>
    fetchAdmin('/reviews/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) }),

  // ===== Itineraries =====
  getItineraries: (params: { page?: number; search?: string; userId?: string; status?: string } = {}) =>
    fetchAdmin(`/itineraries${qs(params)}`),
  getItinerary: (id: string) => fetchAdmin(`/itineraries/${id}`),
  deleteItinerary: (id: string) =>
    fetchAdmin(`/itineraries/${id}`, { method: 'DELETE' }),
  bulkDeleteItineraries: (ids: string[]) =>
    fetchAdmin('/itineraries/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) }),

  // ===== Tours (tour cộng đồng /my-tours) =====
  getTours: (params: { page?: number; search?: string; category?: string; priceRange?: string } = {}) =>
    fetchAdmin(`/tours${qs(params)}`),
  createTour: (data: object) =>
    fetchAdmin('/tours', { method: 'POST', body: JSON.stringify(data) }),
  updateTour: (id: string, data: object) =>
    fetchAdmin(`/tours/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTour: (id: string) =>
    fetchAdmin(`/tours/${id}`, { method: 'DELETE' }),
  bulkDeleteTours: (ids: string[]) =>
    fetchAdmin('/tours/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) }),
  generateTour: (answers: object) =>
    fetchAdmin('/tours/generate', { method: 'POST', body: JSON.stringify(answers) }),

  // ===== Chats =====
  getChats: (params: { page?: number; search?: string; userId?: string } = {}) =>
    fetchAdmin(`/chats${qs(params)}`),
  getChat: (id: string) => fetchAdmin(`/chats/${id}`),
  deleteChat: (id: string) =>
    fetchAdmin(`/chats/${id}`, { method: 'DELETE' }),
  bulkDeleteChats: (ids: string[]) =>
    fetchAdmin('/chats/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) }),
};
