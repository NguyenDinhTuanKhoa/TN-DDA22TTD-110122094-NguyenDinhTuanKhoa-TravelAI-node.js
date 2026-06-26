'use client';
import { useState, useRef, useEffect, useCallback, isValidElement, Children } from 'react';
import type { ReactElement } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '../context/AuthContext';
import DestinationMiniCard, { DestinationMini } from '../components/DestinationMiniCard';
import ClarifyForm, { ClarifyFormData } from '../components/ClarifyForm';
import dynamic from 'next/dynamic';

const ChatMap = dynamic(() => import('../components/ChatMap'), { ssr: false });

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  clarifyForm?: ClarifyFormData | null; // form làm rõ (parse từ block json_form)
  clarifySubmitted?: boolean;           // đã submit → form trơ
}

interface ChatHistory {
  _id: string;
  title: string;
  lastMessage: string;
  createdAt: string;
}

interface DestinationName { name: string; city: string; }

// Strip json_itinerary block trước khi hiển thị
// Bắt cả 3 trường hợp: closed fence, unclosed fence (stream cắt giữa), raw JSON không fence
const stripJsonBlock = (text: string): string =>
  text
    .replace(/```json_itinerary[\s\S]*?```/g, '')  // closed fence
    .replace(/```json_itinerary[\s\S]*$/g, '')      // unclosed fence ở đuôi
    .replace(/```json_form[\s\S]*?```/g, '')        // form làm rõ (closed)
    .replace(/```json_form[\s\S]*$/g, '')           // form làm rõ (unclosed ở đuôi)
    .replace(/```json[\s\S]*?```/g, '')             // ```json ... ``` (variant)
    .replace(/```json[\s\S]*$/g, '')                // ```json unclosed
    .replace(/\{\s*"destinations"\s*:[\s\S]*$/g, '') // raw JSON không fence (unclosed)
    .trim();

// Parse block ```json_form``` (chỉ fence ĐÓNG → không render form dở khi đang stream)
const parseClarifyForm = (text: string): ClarifyFormData | null => {
  const m = text.match(/```json_form\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1].trim());
    return data?.type === 'clarification' && Array.isArray(data.fields) ? (data as ClarifyFormData) : null;
  } catch {
    return null;
  }
};

const quickQuestions = [
  '🏖️ Gợi ý điểm đến biển đẹp',
  '🏔️ Du lịch Sapa cần chuẩn bị gì?',
  '💰 Lịch trình Đà Nẵng 3 ngày 5 triệu',
  '🍜 Ăn gì ngon ở Hội An?',
  '📅 Thời điểm nào đi Phú Quốc đẹp?',
];

// ── Form ClarifyForm mặc định cho nút "Chưa biết đi đâu?" ─────────────────────────
const defaultClarifyForm: ClarifyFormData = {
  type: 'clarification',
  title: 'Mình cần thêm vài thông tin để gợi ý chính xác hơn nhé!',
  fields: [
    {
      key: 'location',
      label: 'Bạn muốn đi đâu?',
      type: 'region',
      required: true,
      options: [
        { value: 'Miền Bắc', icon: '⛰️', label: 'Miền Bắc' },
        { value: 'Miền Trung', icon: '🏖️', label: 'Miền Trung' },
        { value: 'Tây Nguyên', icon: '🌄', label: 'Tây Nguyên' },
        { value: 'Miền Nam', icon: '🌴', label: 'Miền Nam' },
        { value: 'Đà Nẵng', icon: '🌉', label: 'Đà Nẵng' },
        { value: 'Đà Lạt', icon: '🌲', label: 'Đà Lạt' },
        { value: 'Phú Quốc', icon: '🏔️', label: 'Phú Quốc' },
        { value: 'Sa Pa', icon: '🏔️', label: 'Sa Pa' },
        { value: 'Hội An', icon: '🏮', label: 'Hội An' },
        { value: 'Nha Trang', icon: '🐚', label: 'Nha Trang' },
      ],
      allowCustom: true,
      placeholder: 'Nhập tỉnh/thành phố (vd: Đà Nẵng, Phú Quốc...)',
    },
    {
      key: 'days',
      label: 'Đi mấy ngày?',
      type: 'select',
      options: [
        { value: '2 ngày', label: '2 ngày' },
        { value: '3 ngày', label: '3 ngày' },
        { value: '4 ngày', label: '4 ngày' },
        { value: '5 ngày', label: '5 ngày' },
        { value: '1 tuần', label: '1 tuần' },
      ],
      allowCustom: true,
      placeholder: 'Hoặc tự nhập...',
    },
    {
      key: 'budget',
      label: 'Ngân sách dự kiến?',
      type: 'select',
      options: [
        { value: '~3 triệu', label: '~3 triệu' },
        { value: '~5 triệu', label: '~5 triệu' },
        { value: '~10 triệu', label: '~10 triệu' },
        { value: 'trên 15 triệu', label: 'trên 15 triệu' },
      ],
      allowCustom: true,
      placeholder: 'Hoặc tự nhập...',
    },
    {
      key: 'people',
      label: 'Đi mấy người?',
      type: 'select',
      options: [
        { value: 'Một mình', icon: '🧍', label: 'Một mình' },
        { value: 'Cặp đôi', icon: '💑', label: 'Cặp đôi' },
        { value: 'Gia đình', icon: '👨‍👩‍👧', label: 'Gia đình' },
        { value: 'Nhóm bạn', icon: '👥', label: 'Nhóm bạn' },
      ],
      allowCustom: true,
      placeholder: 'Số người cụ thể (vd: 4 người)',
    },
    {
      key: 'interests',
      label: 'Bạn thích gì? (chọn nhiều)',
      type: 'multiselect',
      options: [
        { value: 'Biển', icon: '🏖️', label: 'Biển' },
        { value: 'Núi', icon: '⛰️', label: 'Núi' },
        { value: 'Ẩm thực', icon: '🍜', label: 'Ẩm thực' },
        { value: 'Văn hóa', icon: '🏛️', label: 'Văn hóa' },
        { value: 'Nghỉ dưỡng', icon: '🧘', label: 'Nghỉ dưỡng' },
        { value: 'Khám phá', icon: '🧭', label: 'Khám phá' },
        { value: 'Vui chơi', icon: '🎡', label: 'Vui chơi' },
        { value: 'Chụp ảnh', icon: '📸', label: 'Chụp ảnh' },
        { value: 'Lãng mạn', icon: '💕', label: 'Lãng mạn' },
        { value: 'Dã ngoại', icon: '🏕️', label: 'Dã ngoại' },
      ],
    },
  ],
};

const getWelcomeMessage = (): Message => ({
  id: 'welcome',
  role: 'assistant',
  content: 'Xin chào! 👋 Tôi là TravelAI - trợ lý du lịch thông minh của bạn. Tôi có thể giúp bạn:\n\n• Gợi ý điểm đến phù hợp\n• Lên lịch trình du lịch\n• Tư vấn ngân sách\n• Giới thiệu ẩm thực địa phương\n\nBạn muốn đi đâu? Hãy hỏi tôi bất cứ điều gì! 🌴\n\nNếu bạn chưa biết đi đâu, hãy nhấn vào nút bên dưới để trả lời vài câu hỏi — mình sẽ gợi ý cho bạn nhé! 😊',
  timestamp: new Date(),
});

const formatTime = (date: Date) => {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
};

// ─── Save Success Toast ───────────────────────────────────────────────────────
function SaveSuccessToast({ itineraryId, matchedCount, onClose }: {
  itineraryId: string;
  matchedCount: number;
  onClose: () => void;
}) {
  const router = useRouter();
  useEffect(() => {
    const t = setTimeout(onClose, 8000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-[slideInRight_0.3s_ease] max-w-sm">
      <div className="bg-white border border-emerald-200 rounded-2xl shadow-xl p-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-xl shrink-0">✅</div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-gray-900 text-sm">Lịch trình đã được lưu!</p>
            {matchedCount > 0 ? (
              <p className="text-emerald-600 text-xs mt-0.5">🗺️ {matchedCount} điểm đến tự động thêm từ database</p>
            ) : (
              <p className="text-amber-500 text-xs mt-0.5">⚠️ Chưa tìm thấy điểm đến trong database</p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded-lg p-1 transition-colors shrink-0">✕</button>
        </div>
        <button
          onClick={() => router.push(`/itinerary/${itineraryId}`)}
          className="mt-3 w-full py-2.5 bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-sm font-bold rounded-xl hover:shadow-lg hover:shadow-emerald-500/30 transition-all hover:scale-[1.02] flex items-center justify-center gap-2"
        >
          🗺️ Xem bản đồ hành trình →
        </button>
      </div>
    </div>
  );
}

export default function AIChatPage() {
  const { user, token, loading: authLoading, logout } = useAuth();
  const router = useRouter();
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const prefilledQ = searchParams?.get('q') || '';
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [chatHistories, setChatHistories] = useState<ChatHistory[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mapWidth, setMapWidth] = useState(440); // px — độ rộng panel bản đồ (kéo để chỉnh)
  const isResizingRef = useRef(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [smartPromptProcessed, setSmartPromptProcessed] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false); // Banner khi token hết hạn
  // Track last user message + AbortController để retry / cancel
  const [lastUserMessage, setLastUserMessage] = useState<string>('');
  const abortControllerRef = useRef<AbortController | null>(null);

  // Destination cards per message
  const [msgDestinations, setMsgDestinations] = useState<Record<string, DestinationMini[]>>({});

  // Cache danh sách tên địa danh từ API (chỉ fetch 1 lần)
  const destinationNamesRef = useRef<DestinationName[]>([]);

  // Save itinerary
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [savingContent, setSavingContent] = useState('');
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveForm, setSaveForm] = useState({ title: '', description: '', startDate: '', endDate: '' });
  const [saveSuccessId, setSaveSuccessId] = useState('');
  const [saveMatchedCount, setSaveMatchedCount] = useState(0);
  const [saveError, setSaveError] = useState('');
  // Quick-create từ destination cards
  const [quickDests, setQuickDests] = useState<DestinationMini[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const API_URL = process.env.NEXT_PUBLIC_API_URL;

  // Pre-fill input từ query param ?q= (khi redirect từ Weather Panel)
  useEffect(() => {
    if (prefilledQ) setInput(prefilledQ);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Xử lý khi token hết hạn / không hợp lệ ────────────────────────────────────
  const handleUnauthorized = () => {
    logout(); // Xóa token + user khỏi localStorage và state
    setCurrentChatId(null);
    setChatHistories([]);
    setSessionExpired(true); // Hiện banner thông báo
  };

  // ── Detect itinerary content ────────────────────────────────────────────────
  const isItineraryContent = (content: string) => {
    const keywords = [
      'lịch trình', 'ngày 1', 'ngày 2', 'day 1', 'day 2',
      'buổi sáng', 'buổi chiều', 'buổi tối', 'sáng:', 'chiều:', 'tối:',
      'nên đi', 'điểm đến', 'gợi ý', 'đề xuất',
    ];
    const lowerContent = content.toLowerCase();
    return keywords.filter(k => lowerContent.includes(k)).length >= 2;
  };

  // ── Fetch danh sách tên địa danh từ API (1 lần khi load) ───────────────────
  useEffect(() => {
    if (!API_URL) return;
    fetch(`${API_URL}/destinations/names`)
      .then(r => r.json())
      .then(d => { if (d.success) destinationNamesRef.current = d.data; })
      .catch(() => {}); // Fail silently
  }, [API_URL]);

  // ── Fetch destinations mention trong AI response ────────────────────────────
  // Backend trích địa danh (khớp không dấu/hoa thường + lõi tên + lọc đúng tỉnh ngữ cảnh)
  const fetchMentionedDestinations = useCallback(async (messageId: string, text: string, question = '') => {
    if (!API_URL || !text) return;
    try {
      const res = await fetch(`${API_URL}/destinations/from-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Gửi kèm câu hỏi để backend bỏ qua card khi người dùng hỏi ngoài lề
        // (kiến thức chung / hành chính), tránh hiện điểm đến sai ngữ cảnh.
        body: JSON.stringify({ text, question }),
      });
      const d = await res.json();
      if (d.success && d.data?.length > 0) {
        setMsgDestinations(prev => ({ ...prev, [messageId]: d.data as DestinationMini[] }));
      }
    } catch (_) {}
  }, [API_URL]);

  // ── Smart title extraction ──────────────────────────────────────────────────
  const extractSmartTitle = (text: string): string => {
    const headerMatch = text.match(/#+\s*(?:📅|🗺️|✈️|🏖️)?\s*(?:lịch trình\s*)?(\d+\s*ngày[^#\n]{0,40})/i)
                     || text.match(/lịch trình\s+(\d+\s*ngày[^,\n]{0,40})/i);
    if (headerMatch) return headerMatch[1].replace(/[*#]/g, '').trim();

    const tripMatch = text.match(/(\d+\s*ngày(?:\s*\d+\s*đêm)?\s*(?:tại|ở|đến|khám phá)\s*[^\n,\.]{3,40})/i);
    if (tripMatch) return tripMatch[1].replace(/[*#]/g, '').trim();

    const days = text.match(/(\d+)\s*ngày/i)?.[1] || '';

    // Đếm tần suất xuất hiện của mỗi địa danh → chọn địa danh xuất hiện nhiều nhất
    // (tránh "Hồ Chí Minh" trong "Chủ tịch Hồ Chí Minh" winning over real destination)
    let bestPlace = '';
    let bestCount = 0;
    const placesList = destinationNamesRef.current.map(d => d.name).filter(Boolean);
    
    for (const place of placesList) {
      // Chỉ đếm khi xuất hiện sau khoảng trắng hoặc đầu dòng (không phải trong tên ghép)
      const escaped = place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matches = text.match(new RegExp(`(?:^|[\\s,.:'"(])${escaped}`, 'gi')) || [];
      if (matches.length > bestCount) { bestCount = matches.length; bestPlace = place; }
    }
    if (bestPlace) return days ? `Du lịch ${bestPlace} ${days} ngày` : `Du lịch ${bestPlace}`;

    const h2Match = text.match(/##\s*([^\n]{5,80})/);
    if (h2Match) {
      const clean = h2Match[1].replace(/[*#📅🗺️✈️🏖️🌴]/g, '').trim();
      if (clean.length > 4) {
        if (clean.length <= 60) return clean;
        // Cắt ở ranh giới từ gần nhất để không mất chữ giữa chừng
        const cut = clean.slice(0, 60);
        const lastSpace = cut.lastIndexOf(' ');
        return (lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim();
      }
    }
    return 'Lịch trình du lịch';

  };

  // ── Save itinerary modal open ───────────────────────────────────────────────
  const handleOpenSaveModal = (content: string) => {
    const title = extractSmartTitle(content);
    const daysMatch = content.match(/(\d+)\s*ngày/i);
    const tripDays = daysMatch ? parseInt(daysMatch[1]) : 3;

    setSavingContent(content);
    setQuickDests([]); // Đây là save từ text AI, không phải quick mode
    setSaveError(''); // Reset lỗi cũ
    setSaveForm({
      title,
      // Lưu TOÀN BỘ kế hoạch (đã loại bỏ khối json_itinerary nội bộ), không cắt ngắn
      description: content.replace(/```json_itinerary[\s\S]*?```/g, '').trim(),
      startDate: new Date().toISOString().split('T')[0],
      endDate: new Date(Date.now() + tripDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    });
    setShowSaveModal(true);
  };

  // ── Quick-create từ destination cards ──────────────────────────────────────
  const handleQuickCreateFromDests = (dests: DestinationMini[], aiContent: string) => {
    if (dests.length === 0) return;
    // Mặc định mỗi điểm 1 ngày, tối đa 5 ngày
    const tripDays = Math.min(dests.length, 5);
    const city = dests[0]?.location?.city || '';
    const title = city ? `Du lịch ${city} ${tripDays} ngày` : extractSmartTitle(aiContent) || `Lịch trình ${tripDays} ngày`;

    setSavingContent(aiContent);
    setQuickDests(dests);
    setSaveError('');
    setSaveForm({
      title,
      description: `Lịch trình ${dests.length} điểm đến: ${dests.map(d => d.name).join(', ')}`.substring(0, 500),
      startDate: new Date().toISOString().split('T')[0],
      endDate: new Date(Date.now() + tripDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    });
    setShowSaveModal(true);
  };

  const handleSaveItinerary = async () => {
    // Đọc token fresh từ localStorage để tránh stale closure
    const freshToken = token || localStorage.getItem('token');
    if (!freshToken || !saveForm.title || !saveForm.startDate || !saveForm.endDate) {
      setSaveError(!freshToken ? 'Bạn cần đăng nhập để lưu lịch trình' : 'Vui lòng điền đầy đủ thông tin');
      return;
    }
    setSaveLoading(true);
    setSaveError('');
    try {
      const isQuickMode = quickDests.length > 0;
      const endpoint = isQuickMode ? '/itineraries' : '/itineraries/from-ai';
      const body = isQuickMode
        ? {
            title: saveForm.title,
            description: saveForm.description,
            startDate: saveForm.startDate,
            endDate: saveForm.endDate,
            destinations: quickDests.map((d, i) => ({ destination: d._id, order: i + 1 })),
            status: 'planning',
          }
        : {
            title: saveForm.title,
            description: saveForm.description,
            startDate: saveForm.startDate,
            endDate: saveForm.endDate,
            aiText: savingContent,
            status: 'planning',
          };

      const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setShowSaveModal(false);
        setSaveError('');
        setSaveSuccessId(data.data._id);
        setSaveMatchedCount(isQuickMode ? quickDests.length : (data.matchedCount || 0));
        setQuickDests([]);
      } else {
        console.error('[Save Itinerary] API error:', res.status, data);
        setSaveError(data.message || `Lỗi server: ${res.status}`);
      }
    } catch (error: any) {
      console.error('[Save Itinerary] Network error:', error);
      setSaveError('Lỗi kết nối. Vui lòng kiểm tra server backend.');
    }
    setSaveLoading(false);
  };

  // ── Effects ─────────────────────────────────────────────────────────────────
  useEffect(() => { setMessages([getWelcomeMessage()]); }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (user && token) loadChatHistories();
    else { setChatHistories([]); setCurrentChatId(null); }
  }, [user, token]);

  useEffect(() => {
    if (authLoading || smartPromptProcessed) return;
    const smartPrompt = localStorage.getItem('smartSuggestionPrompt');
    if (smartPrompt) {
      localStorage.removeItem('smartSuggestionPrompt');
      setSmartPromptProcessed(true);
      setTimeout(() => sendMessage(smartPrompt), 300);
    }
  }, [authLoading, smartPromptProcessed]);

  // ── Kéo để chỉnh độ rộng bản đồ ───────────────────────────────────────────────
  useEffect(() => {
    const MIN_W = 320;
    const MAX_W = 900;
    const onMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      // Bản đồ nằm sát mép phải → width = khoảng cách từ chuột tới mép phải cửa sổ
      const w = window.innerWidth - e.clientX;
      setMapWidth(Math.min(MAX_W, Math.max(MIN_W, w)));
    };
    const onUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startResizingMap = (e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // ── API helpers ─────────────────────────────────────────────────────────────
  const loadChatHistories = async () => {
    try {
      const res = await fetch(`${API_URL}/ai/history`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setChatHistories(data.data);
    } catch (error) { console.error(error); }
  };

  const loadChat = async (chatId: string) => {
    setLoadingHistory(true);
    try {
      const res = await fetch(`${API_URL}/ai/history/${chatId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) {
        setCurrentChatId(chatId);
        const rawMsgs = data.data.messages;
        const loaded: Message[] = rawMsgs.map((m: any, idx: number) => ({
          id: `${chatId}-${idx}`,
          role: m.role,
          // Strip think tags + JSON block từ message cũ trong DB (legacy data có thể bị leak)
          content: m.role === 'assistant' ? stripJsonBlock(stripThinkTags(m.content)) : m.content,
          timestamp: new Date(m.timestamp),
          // Re-parse form làm rõ; nếu tin ngay sau là user → form đã được trả lời → để trơ
          clarifyForm: m.role === 'assistant' ? parseClarifyForm(m.content) : null,
          clarifySubmitted: m.role === 'assistant' && rawMsgs[idx + 1]?.role === 'user',
        }));
        setMessages(loaded.length > 0 ? loaded : [getWelcomeMessage()]);
        // Cards: ưu tiên destinations đã persist trong DB (0 round-trip); chỉ gọi
        // /from-text cho message CŨ chưa có field (tương thích ngược dữ liệu legacy).
        setMsgDestinations({});
        const persisted: Record<string, DestinationMini[]> = {};
        loaded.forEach((msg, idx) => {
          if (msg.role !== 'assistant' || !msg.content) return;
          if (msg.clarifyForm) return; // form làm rõ → không có card điểm đến
          const raw = rawMsgs[idx]?.destinations;
          // Lọc null (destination đã bị xóa khỏi DB → populate trả null)
          const cards = Array.isArray(raw)
            ? raw.filter((d: unknown) => d && typeof d === 'object' && '_id' in (d as object))
            : [];
          if (cards.length > 0) {
            persisted[msg.id] = cards as DestinationMini[];
          } else if (!Array.isArray(raw) || raw.length === 0) {
            // legacy: chưa có field destinations → trích lại, kèm câu hỏi user liền trước
            // để bỏ qua card khi đó là câu hỏi ngoài lề.
            const prevUserQ = rawMsgs[idx - 1]?.role === 'user' ? rawMsgs[idx - 1].content : '';
            fetchMentionedDestinations(msg.id, msg.content, prevUserQ);
          }
        });
        if (Object.keys(persisted).length > 0) setMsgDestinations(persisted);
      }
    } catch (error) { console.error(error); }
    setLoadingHistory(false);
  };

  const createNewChat = async () => {
    if (!user || !token) { setMessages([getWelcomeMessage()]); setCurrentChatId(null); return; }
    try {
      const res = await fetch(`${API_URL}/ai/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) { setCurrentChatId(data.data._id); setMessages([getWelcomeMessage()]); loadChatHistories(); }
    } catch (error) { console.error(error); }
  };

  const deleteChat = async (chatId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Xóa cuộc trò chuyện này?')) return;
    try {
      await fetch(`${API_URL}/ai/history/${chatId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      setChatHistories(prev => prev.filter(h => h._id !== chatId));
      if (currentChatId === chatId) { setCurrentChatId(null); setMessages([getWelcomeMessage()]); }
    } catch (error) { console.error(error); }
  };

  // ── Strip <think>...</think> from display content ──────────────────────────
  const stripThinkTags = (text: string): string => {
    return text
      .replace(/<think>[\s\S]*?<\/think>/g, '')  // strip closed think blocks
      .replace(/<think>[\s\S]*$/, '')             // strip unclosed think (model cut off mid-thought)
      .trim();
  };

  // ── SSE Streaming send ───────────────────────────────────────────────────────
  const sendMessage = async (content: string, isRetry = false) => {
    if (!content.trim() || isLoading) return;

    setLastUserMessage(content.trim());

    // Nếu là retry, chỉ thêm placeholder mới, không thêm user message
    if (!isRetry) {
      const userMessage: Message = {
        id: Date.now().toString(), role: 'user', content: content.trim(), timestamp: new Date(),
      };
      setMessages(prev => [...prev, userMessage]);
      setInput('');
    } else {
      // Retry: xoá error message cuối nếu có
      setMessages(prev => prev[prev.length - 1]?.content?.startsWith('__ERROR__') ? prev.slice(0, -1) : prev);
    }
    setIsLoading(true);

    // Tạo placeholder message để stream vào
    const aiMsgId = (Date.now() + 1).toString();
    setMessages(prev => [...prev, { id: aiMsgId, role: 'assistant', content: '', timestamp: new Date() }]);

    // Build messages array cho API (loại error message cũ)
    const apiMessages = messages
      .filter(m => m.id !== 'welcome' && !m.content?.startsWith('__ERROR__'))
      .map(m => ({ role: m.role, content: m.content }));
    apiMessages.push({ role: 'user', content: content.trim() });

    // ── Abort + timeout setup ──
    const ac = new AbortController();
    abortControllerRef.current = ac;
    const FIRST_CHUNK_TIMEOUT = 60000;   // 60s chờ chunk đầu tiên (NVIDIA cold-start có thể chậm)
    const IDLE_CHUNK_TIMEOUT = 60000;    // 60s không có chunk nào → coi như stuck (reasoning model có thể pause lâu)

    let firstChunkTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      ac.abort('first-chunk-timeout');
    }, FIRST_CHUNK_TIMEOUT);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let streamDone = false;  // flag để break outer while khi gặp [DONE]
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ac.abort('idle-timeout'), IDLE_CHUNK_TIMEOUT);
    };

    try {
      const freshToken = token || localStorage.getItem('token');
      const freshUserStr = localStorage.getItem('user');
      const isAuthed = !!freshUserStr && !!freshToken;

      // ── Đảm bảo có chatId nếu đã đăng nhập ──
      let chatId = currentChatId;
      if (isAuthed && freshToken && !chatId) {
        try {
          const createRes = await fetch(`${API_URL}/ai/history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}` }
          });
          if (createRes.status === 401) {
            if (firstChunkTimer) clearTimeout(firstChunkTimer);
            handleUnauthorized(); setIsLoading(false); return;
          }
          const createData = await createRes.json();
          if (createData.success && createData.data?._id) {
            chatId = createData.data._id;
            setCurrentChatId(chatId);
          }
        } catch (err) {
          console.warn('[AI Chat] Cannot create session:', err);
        }
      }

      // ── Gọi streaming endpoint ──
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (isAuthed && freshToken) headers['Authorization'] = `Bearer ${freshToken}`;

      const res = await fetch(`${API_URL}/ai/chat/stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: apiMessages, chatId: chatId || undefined }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Stream request failed: ${res.status}`);
      }

      // ── Đọc SSE stream ──
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let rawBuffer = '';

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') {
            streamDone = true;
            // Clear idle timer ngay lập tức để tránh race condition fire sau khi stream xong
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            break;
          }

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.error) throw new Error(parsed.error);
            const tk = parsed.content || '';
            if (!tk) continue;

            // Nhận chunk đầu → tắt first-chunk timer, bật idle timer
            if (firstChunkTimer) { clearTimeout(firstChunkTimer); firstChunkTimer = null; }
            resetIdleTimer();

            rawBuffer += tk;
            let displayBuffer = rawBuffer
              .replace(/<think>[\s\S]*?<\/think>/g, '')
              .replace(/<think>[\s\S]*$/, '')
              .replace(/```json_itinerary[\s\S]*?```/g, '')
              .replace(/```json_itinerary[\s\S]*$/g, '')
              .replace(/```json_form[\s\S]*?```/g, '')
              .replace(/```json_form[\s\S]*$/g, '')
              .replace(/```json[\s\S]*?```/g, '')
              .replace(/```json[\s\S]*$/g, '')
              .replace(/\{\s*"destinations"\s*:[\s\S]*$/g, '')
              .trim();

            setMessages(prev => prev.map(m =>
              m.id === aiMsgId ? { ...m, content: displayBuffer } : m
            ));
          } catch (_) {}
        }
      }

      if (firstChunkTimer) clearTimeout(firstChunkTimer);
      if (idleTimer) clearTimeout(idleTimer);

      // Sau khi stream xong, lấy nội dung cuối sạch
      const strippedThink = stripThinkTags(rawBuffer);
      const finalContent = stripJsonBlock(strippedThink);
      const clarifyForm = parseClarifyForm(rawBuffer);

      // Chỉ báo lỗi rỗng khi vừa không có text VỪA không có form làm rõ
      if (!finalContent.trim() && !clarifyForm) {
        // Phân biệt 2 loại empty: rawBuffer hoàn toàn rỗng vs chỉ có <think>/json block
        const hadAnyOutput = rawBuffer.trim().length > 0;
        const errMsg = hadAnyOutput
          ? 'AI đã suy nghĩ nhưng chưa kịp đưa ra câu trả lời. Hãy thử lại với câu hỏi rõ hơn.'
          : 'Không nhận được phản hồi từ AI. Có thể server đang quá tải.';
        console.warn('[AI Chat] Empty final content. rawBuffer length:', rawBuffer.length);
        setMessages(prev => prev.map(m =>
          m.id === aiMsgId ? { ...m, content: `__ERROR__${errMsg}` } : m
        ));
        return;
      }
      setMessages(prev => prev.map(m =>
        m.id === aiMsgId ? { ...m, content: finalContent, clarifyForm } : m
      ));
      // Form làm rõ KHÔNG phải gợi ý điểm đến → không trích card (kẻo lời mở đầu kiểu
      // "gợi ý bãi biển hợp ý" khớp nhầm địa danh tên "Bãi biển").
      if (!clarifyForm) fetchMentionedDestinations(aiMsgId, finalContent, content);
      if (isAuthed) loadChatHistories();

    } catch (error: any) {
      if (firstChunkTimer) clearTimeout(firstChunkTimer);
      if (idleTimer) clearTimeout(idleTimer);

      const isAbort = error?.name === 'AbortError' || ac.signal.aborted;
      const reason = ac.signal.reason;
      let errMsg = 'Có lỗi xảy ra. Vui lòng thử lại.';
      if (isAbort) {
        if (reason === 'first-chunk-timeout') errMsg = 'AI phản hồi quá lâu (>60s). Có thể server đang quá tải.';
        else if (reason === 'idle-timeout') errMsg = 'Mất kết nối với AI giữa chừng. Hãy thử lại.';
        else errMsg = 'Đã hủy yêu cầu.';
        // AbortError là behavior đã handle (timeout/user-cancel) → chỉ warn nhẹ, không phải error nghiêm trọng
        console.warn('[AI Chat] Stream aborted:', reason || 'unknown');
      } else {
        console.error('[AI Chat] Stream error:', error);
        if (error?.message?.includes('Failed to fetch')) {
          errMsg = 'Không kết nối được tới server. Kiểm tra backend đang chạy.';
        }
      }
      setMessages(prev => prev.map(m =>
        m.id === aiMsgId ? { ...m, content: `__ERROR__${errMsg}` } : m
      ));
    } finally {
      abortControllerRef.current = null;
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleStop = () => {
    abortControllerRef.current?.abort('user-cancel');
  };
  const handleRetry = () => {
    if (lastUserMessage && !isLoading) sendMessage(lastUserMessage, true);
  };

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); sendMessage(input); };

  // ── Inject ClarifyForm vào chat khi bấm "Chưa biết đi đâu?" ────────────────
  const handleQuickClarify = () => {
    const aiMsgId = `clarify-${Date.now()}`;
    const assistantMsg: Message = {
      id: aiMsgId,
      role: 'assistant',
      content: 'Bạn chưa biết đi đâu? Không sao! 😊 Hãy chọn vài thông tin bên dưới để mình gợi ý lịch trình chính xác nhé! 👇',
      timestamp: new Date(),
      clarifyForm: defaultClarifyForm,
      clarifySubmitted: false,
    };
    setMessages(prev => [...prev, assistantMsg]);
  };


  // ── Render ───────────────────────────────────────────────────────────────────

  // Điểm đến của gợi ý AI MỚI NHẤT có địa danh → để vẽ lên bản đồ bên phải
  const latestMapDests: DestinationMini[] = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && msgDestinations[m.id]?.length) {
        return msgDestinations[m.id];
      }
    }
    return [];
  })();
  const hasMapData = latestMapDests.some(
    d => d?.location?.coordinates?.lat != null && d?.location?.coordinates?.lng != null
  );

  return (
    <div className="h-screen bg-gradient-to-br from-blue-50 via-white to-blue-50 flex">

      {/* ── SIDEBAR ──────────────────────────────────────────────────────────── */}
      <div className={`${sidebarOpen ? 'w-72' : 'w-0'} transition-all duration-300 bg-white border-r border-gray-200 flex flex-col overflow-hidden`}>
        <div className="p-4 border-b border-gray-100">
          <button
            onClick={createNewChat}
            className="w-full px-4 py-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl text-blue-700 font-medium transition-all flex items-center justify-center gap-2"
          >
            <span>✨</span> Cuộc trò chuyện mới
          </button>
        </div>

        {user ? (
          <div className="flex-1 overflow-y-auto p-2">
            {chatHistories.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-4">Chưa có lịch sử chat</p>
            ) : (
              <div className="space-y-1">
                {chatHistories.map((chat) => (
                  <div
                    key={chat._id}
                    onClick={() => loadChat(chat._id)}
                    className={`group px-3 py-3 rounded-lg cursor-pointer transition-all flex items-center justify-between ${
                      currentChatId === chat._id ? 'bg-blue-50 text-blue-900 border border-blue-100' : 'hover:bg-gray-50 text-gray-600'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate font-medium">{chat.title}</p>
                      <p className="text-xs text-gray-500">{new Date(chat.lastMessage).toLocaleDateString('vi-VN')}</p>
                    </div>
                    <button
                      onClick={(e) => deleteChat(chat._id, e)}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-50 rounded text-red-500 transition-all"
                    >🗑️</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center p-4">
            <div className="text-center">
              <p className="text-gray-500 text-sm mb-3">Đăng nhập để lưu lịch sử chat</p>
              <Link href="/login" className="inline-block px-4 py-2 bg-gradient-to-r from-sky-500 to-violet-500 text-white text-sm rounded-lg hover:shadow-md transition-shadow">
                Đăng nhập
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Toggle Sidebar */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="absolute top-1/2 -translate-y-1/2 z-10 bg-white hover:bg-gray-50 border border-gray-200 border-l-0 shadow-sm p-2 rounded-r-lg transition-all"
        style={{ left: sidebarOpen ? '288px' : '0' }}
      >
        <span className="text-gray-600">{sidebarOpen ? '◀' : '▶'}</span>
      </button>

      {/* ── MAIN CHAT ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden shadow-[0_0_40px_rgba(0,0,0,0.03)] z-0">
        {/* Header */}
        <header className="bg-white/80 backdrop-blur-xl border-b border-gray-200 shrink-0">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Image src="/logonew.png" alt="Logo" width={40} height={40} className="rounded-xl shadow-sm" />
              <div>
                <h1 className="text-xl font-bold text-gray-900">Travel<span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-500 to-violet-500">AI</span> Chat</h1>
                <p className="text-xs text-gray-500">Powered by StepFun Step-3.7 Flash</p>
              </div>
            </div>
            <Link href="/" className="px-4 py-2 text-gray-500 hover:text-gray-900 transition-colors font-medium">← Về trang chủ</Link>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-gray-50/50">
          {loadingHistory ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full" />
            </div>
          ) : (
            messages.map((message) => (
              <div key={message.id} className={`flex gap-4 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
                {/* Avatar */}
                <div className={`w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center shadow-sm ${
                  message.role === 'user'
                    ? 'bg-gradient-to-r from-sky-500 to-violet-500 text-white'
                    : 'bg-white border border-gray-100'
                }`}>
                  {message.role === 'user' ? '👤' : (
                    <Image src="/logonew.png" alt="TravelAI" width={32} height={32} className="rounded-lg" />
                  )}
                </div>

                {/* Bubble + Cards */}
                <div className={`flex flex-col gap-3 max-w-[80%] ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <div className={`rounded-2xl px-5 py-4 shadow-sm ${
                    message.role === 'user'
                      ? 'bg-gradient-to-r from-sky-500 to-violet-500 text-white rounded-tr-none'
                      : 'bg-white text-gray-800 rounded-tl-none border border-gray-100'
                  }`}>
                    {message.role === 'user' ? (
                      <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
                    ) : message.content === '' ? (
                      <div className="flex gap-1 py-1">
                        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
                        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                      </div>
                    ) : message.content.startsWith('__ERROR__') ? (
                      <div className="flex flex-col gap-3">
                        <div className="flex items-start gap-2.5">
                          <span className="text-red-500 text-lg shrink-0">⚠️</span>
                          <p className="text-red-700 text-sm leading-relaxed">{message.content.replace('__ERROR__', '')}</p>
                        </div>
                        {lastUserMessage && !isLoading && (
                          <button
                            onClick={handleRetry}
                            className="self-start flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-red-500 to-orange-500 text-white text-sm font-semibold rounded-xl hover:shadow-md hover:shadow-red-500/30 hover:scale-105 transition-all"
                          >
                            🔄 Thử lại
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="prose prose-slate prose-sm max-w-none prose-table:text-xs prose-table:border prose-table:border-gray-200 prose-th:bg-sky-50 prose-th:px-2 prose-th:py-1.5 prose-th:border prose-th:border-gray-200 prose-td:px-2 prose-td:py-1.5 prose-td:align-top prose-td:border prose-td:border-gray-200">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            p: ({ children }) => {
                              // Nếu paragraph chứa ảnh → nhóm mỗi img+text thành card trong grid
                              const childArr = Children.toArray(children);
                              const hasImg = childArr.some(
                                c => isValidElement(c) && (c as ReactElement).type === 'img'
                              );
                              if (hasImg) {
                                const groups: (typeof childArr)[] = [];
                                let current: typeof childArr = [];
                                childArr.forEach(child => {
                                  if (isValidElement(child) && (child as ReactElement).type === 'img') {
                                    if (current.length > 0) groups.push(current);
                                    current = [child];
                                  } else {
                                    current.push(child);
                                  }
                                });
                                if (current.length > 0) groups.push(current);
                                return (
                                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 my-2">
                                    {groups.map((group, i) => (
                                      <div key={i} className="flex flex-col items-center text-center gap-1 p-1.5 rounded-xl bg-orange-50/60">
                                        {group}
                                      </div>
                                    ))}
                                  </div>
                                );
                              }
                              return <p className="mb-2 last:mb-0">{children}</p>;
                            },
                            ul: ({ children }) => <ul className="list-disc pl-4 mb-2">{children}</ul>,
                            ol: ({ children }) => <ol className="list-decimal pl-4 mb-2">{children}</ol>,
                            li: ({ children }) => <li className="mb-1">{children}</li>,
                            strong: ({ children }) => <strong className="font-bold text-gray-900">{children}</strong>,
                            img: ({ src, alt }) => (
                              <img
                                src={src}
                                alt={alt}
                                className="w-24 h-24 object-cover rounded-xl shadow-sm border border-gray-200 hover:scale-105 transition-transform"
                                loading="lazy"
                              />
                            ),
                          }}
                        >
                          {message.content}
                        </ReactMarkdown>
                      </div>
                    )}
                    {message.content !== '' && !message.content.startsWith('__ERROR__') && (
                      <p className={`text-xs mt-2 ${message.role === 'user' ? 'text-white/80' : 'text-gray-400'}`}>
                        {formatTime(message.timestamp)}
                      </p>
                    )}

                    {/* "Chưa biết đi đâu?" button inside welcome message */}
                    {message.id === 'welcome' && (
                      <div className="mt-3 pt-3 border-t border-gray-100">
                        <button
                          onClick={handleQuickClarify}
                          className="group flex items-center gap-2.5 w-full px-5 py-3 bg-gradient-to-r from-sky-400 via-blue-500 to-indigo-500 text-white text-sm font-bold rounded-xl shadow-md hover:shadow-lg hover:shadow-blue-500/30 hover:scale-[1.02] transition-all"
                        >
                          <span className="flex-1 text-left">Chưa biết đi đâu? Để mình gợi ý!</span>
                          <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                          </svg>
                        </button>
                      </div>
                    )}

                    {/* Save as Itinerary Button */}
                    {message.role === 'assistant' && message.id !== 'welcome' && !message.content.startsWith('__ERROR__') && isItineraryContent(message.content) && user && (
                      <div className="mt-3 pt-3 border-t border-gray-100">
                        <button
                          onClick={() => handleOpenSaveModal(message.content)}
                          className="flex items-center gap-2 px-4 py-2 bg-sky-50 border border-sky-100 text-sky-600 text-sm font-semibold rounded-xl hover:bg-sky-100 hover:text-sky-700 transition-all hover:scale-105"
                        >
                          📅 Lưu thành lịch trình
                        </button>
                      </div>
                    )}
                  </div>

                  {/* ── Clarification Form (yêu cầu mơ hồ) ── */}
                  {message.role === 'assistant' && message.clarifyForm && (
                    <ClarifyForm
                      data={message.clarifyForm}
                      disabled={!!message.clarifySubmitted || isLoading}
                      onSubmit={(composed) => {
                        setMessages(prev => prev.map(m =>
                          m.id === message.id ? { ...m, clarifySubmitted: true } : m
                        ));
                        sendMessage(composed);
                      }}
                    />
                  )}

                  {/* ── Destination Mini Cards ── */}
                  {message.role === 'assistant' && message.id !== 'welcome' && msgDestinations[message.id]?.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <p className="text-xs text-gray-500 flex items-center gap-1.5 font-medium">
                          <span>📍</span> Điểm đến được nhắc đến
                        </p>
                        {user && (
                          <button
                            onClick={() => handleQuickCreateFromDests(msgDestinations[message.id], message.content)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-orange-500 to-pink-500 text-white text-xs font-semibold rounded-lg shadow-sm hover:shadow-md hover:scale-105 transition-all"
                            title={`Tạo lịch trình với ${msgDestinations[message.id].length} điểm đến`}
                          >
                            🗺️ Tạo lịch trình ngay ({msgDestinations[message.id].length})
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {msgDestinations[message.id].map(dest => (
                          <DestinationMiniCard key={dest._id} destination={dest} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}

          {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
            <div className="flex gap-4">
              <div className="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center bg-white border border-gray-100 shadow-sm">
                <Image src="/logonew.png" alt="TravelAI" width={32} height={32} className="rounded-lg" />
              </div>
              <div className="rounded-2xl rounded-tl-none px-5 py-4 bg-white border border-gray-100 shadow-sm">
                <div className="flex gap-1">
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick Questions */}
        {messages.length <= 1 && (
          <div className="px-6 pb-4 shrink-0 bg-gray-50/50">
            <p className="text-gray-500 text-sm mb-3 font-medium">Gợi ý câu hỏi:</p>
            <div className="flex flex-wrap gap-2">
              {quickQuestions.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => sendMessage(q)}
                  className="px-4 py-2 bg-white hover:bg-blue-50 rounded-full text-blue-700 text-sm transition-all border border-blue-100 shadow-sm hover:border-blue-300"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Session Expired Banner */}
        {sessionExpired && (
          <div className="mx-4 mb-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between gap-3 shrink-0 animate-[fadeInScale_0.2s_ease] shadow-sm">
            <div className="flex items-center gap-2.5">
              <span className="text-amber-500 text-lg shrink-0">⚠️</span>
              <div>
                <p className="text-amber-800 font-semibold text-sm">Phiên đăng nhập đã hết hạn</p>
                <p className="text-amber-600/80 text-xs">Bạn vẫn có thể chat nhưng lịch sử sẽ không được lưu</p>
              </div>
            </div>
            <Link
              href="/login"
              className="shrink-0 px-4 py-2 bg-amber-100 hover:bg-amber-200 text-amber-900 font-bold text-xs rounded-lg transition-all hover:scale-105"
            >
              Đăng nhập lại
            </Link>
          </div>
        )}

        {/* Input */}
        <div className="p-4 bg-white/80 backdrop-blur-xl border-t border-gray-200 shrink-0">
          <form onSubmit={handleSubmit} className="flex gap-3">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Hỏi về du lịch..."
              disabled={isLoading}
              className="flex-1 px-5 py-4 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 shadow-inner"
            />
            {isLoading ? (
              <button
                type="button"
                onClick={handleStop}
                className="px-6 py-4 bg-gradient-to-r from-red-500 to-orange-500 text-white font-semibold rounded-xl hover:shadow-lg hover:shadow-red-500/30 transition-all flex items-center gap-2"
                title="Dừng yêu cầu hiện tại"
              >
                <span className="w-3 h-3 bg-white rounded-sm" /> Dừng
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                className="px-6 py-4 bg-gradient-to-r from-sky-500 to-violet-500 text-white font-semibold rounded-xl hover:shadow-lg hover:shadow-violet-500/30 transition-all disabled:opacity-50"
              >
                ➤
              </button>
            )}
          </form>
        </div>
      </div>

      {/* ── MAP PANEL (desktop only) ──────────────────────────────────────────── */}
      {hasMapData && (
        <>
          {/* Thanh kéo chỉnh độ rộng bản đồ */}
          <div
            onMouseDown={startResizingMap}
            className="hidden lg:flex items-center justify-center w-2 shrink-0 cursor-col-resize group relative z-10"
            title="Kéo để chỉnh độ rộng bản đồ"
          >
            <div className="absolute inset-y-0 w-px bg-gray-200 group-hover:bg-blue-400 transition-colors" />
            <div className="relative w-1.5 h-12 rounded-full bg-gray-300 group-hover:bg-blue-500 group-active:bg-blue-600 transition-colors shadow-sm" />
          </div>

          <div
            className="hidden lg:flex flex-col shrink-0 bg-gray-50/50 border-l border-gray-200 p-4 relative z-0"
            style={{ width: mapWidth }}
          >
            <div className="flex-1 flex flex-col rounded-2xl overflow-hidden bg-white border border-gray-200 shadow-sm">
              <div className="px-5 py-4 border-b border-gray-100 shrink-0 flex items-center gap-2.5 bg-white">
                <span className="text-xl">🗺️</span>
                <div>
                  <p className="font-bold text-gray-800 text-sm">Bản đồ hành trình</p>
                  <p className="text-xs text-gray-400">{latestMapDests.length} điểm đến từ gợi ý mới nhất</p>
                </div>
              </div>
              <div className="flex-1 relative">
                <ChatMap destinations={latestMapDests} />
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── SAVE ITINERARY MODAL ──────────────────────────────────────────────── */}
      {showSaveModal && (
        <div className="fixed inset-0 bg-gray-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-gray-200 rounded-2xl shadow-xl w-full max-w-lg">
            <div className="p-6 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                  {quickDests.length > 0 ? '🗺️ Tạo Lịch Trình Nhanh' : '📅 Lưu Lịch Trình'}
                </h3>
                <p className="text-gray-500 text-sm mt-0.5">
                  {quickDests.length > 0
                    ? `Tạo lịch trình với ${quickDests.length} điểm đến đã chọn`
                    : 'Lưu gợi ý từ AI thành lịch trình của bạn'}
                </p>
              </div>
              <button onClick={() => { setShowSaveModal(false); setQuickDests([]); }} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-all">✕</button>
            </div>

            <div className="p-6 space-y-4">
              {saveError && (
                <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm flex items-center gap-2">
                  <span>⚠️</span> {saveError}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Tên lịch trình *</label>
                <input
                  type="text"
                  value={saveForm.title}
                  onChange={e => setSaveForm({ ...saveForm, title: e.target.value })}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Ví dụ: Du lịch Đà Nẵng 3 ngày"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Ngày bắt đầu *</label>
                  <input
                    type="date"
                    value={saveForm.startDate}
                    onChange={e => setSaveForm({ ...saveForm, startDate: e.target.value })}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Ngày kết thúc *</label>
                  <input
                    type="date"
                    value={saveForm.endDate}
                    onChange={e => setSaveForm({ ...saveForm, endDate: e.target.value })}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* Preview info */}
              {quickDests.length > 0 ? (
                <div className="bg-orange-50 border border-orange-100 rounded-xl px-4 py-3 shadow-sm">
                  <p className="text-orange-700 text-xs font-semibold mb-2 flex items-center gap-1.5">
                    <span>📍</span> {quickDests.length} điểm đến sẽ được thêm vào lịch trình:
                  </p>
                  <ul className="text-orange-700 text-xs space-y-1 ml-1">
                    {quickDests.map((d, i) => (
                      <li key={d._id} className="truncate">
                        <span className="font-semibold">{i + 1}.</span> {d.name}
                        {d.location?.city && <span className="text-orange-500"> · {d.location.city}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="bg-sky-50 border border-sky-100 rounded-xl px-4 py-3 flex items-start gap-2 shadow-sm">
                  <span className="text-sky-500 shrink-0 mt-0.5">🤖</span>
                  <p className="text-sky-700 text-xs leading-relaxed">
                    AI sẽ tự động nhận diện tên địa điểm trong lịch trình và thêm vào bản đồ hành trình!
                  </p>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-gray-100 flex gap-3 justify-end bg-gray-50/50 rounded-b-2xl">
              <button onClick={() => { setShowSaveModal(false); setQuickDests([]); }} className="px-5 py-2.5 bg-white border border-gray-200 text-gray-600 rounded-xl hover:bg-gray-50 transition-all font-medium">Hủy</button>
              <button
                onClick={handleSaveItinerary}
                disabled={saveLoading || !saveForm.title || !saveForm.startDate || !saveForm.endDate}
                className={`px-5 py-2.5 text-white font-semibold rounded-xl hover:shadow-lg transition-all disabled:opacity-50 flex items-center gap-2 ${
                  quickDests.length > 0
                    ? 'bg-gradient-to-r from-orange-500 to-pink-500 hover:shadow-orange-500/30'
                    : 'bg-gradient-to-r from-sky-500 to-violet-500 hover:shadow-sky-500/30'
                }`}
              >
                {saveLoading ? <><span className="animate-spin">⏳</span> Đang tạo...</> : (quickDests.length > 0 ? <>🗺️ Tạo lịch trình</> : <>📅 Lưu lịch trình</>)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── SAVE SUCCESS TOAST ────────────────────────────────────────────────── */}
      {saveSuccessId && (
        <SaveSuccessToast
          itineraryId={saveSuccessId}
          matchedCount={saveMatchedCount}
          onClose={() => { setSaveSuccessId(''); setSaveMatchedCount(0); }}
        />
      )}


    </div>
  );
}
