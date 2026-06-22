'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { adminApi } from '../../lib/adminApi';

interface ActivityLog {
  _id: string;
  admin?: { name?: string } | null;
  action: 'create' | 'update' | 'delete' | 'bulk_delete' | 'ban' | 'unban' | 'role_change';
  targetModel: 'User' | 'Destination' | 'Review' | 'Itinerary' | 'ChatHistory';
  targetLabel?: string;
  createdAt: string;
}

interface NotificationsData {
  recent: ActivityLog[];
  unreadCount: number;
}

const ACTION_ICON: Record<ActivityLog['action'], string> = {
  create: '➕',
  update: '✏️',
  delete: '🗑️',
  bulk_delete: '🧹',
  ban: '🔒',
  unban: '🔓',
  role_change: '🛡️',
};
const ACTION_LABEL: Record<ActivityLog['action'], string> = {
  create: 'tạo',
  update: 'cập nhật',
  delete: 'xóa',
  bulk_delete: 'xóa hàng loạt',
  ban: 'khóa',
  unban: 'mở khóa',
  role_change: 'đổi vai trò',
};
const MODEL_LABEL: Record<ActivityLog['targetModel'], string> = {
  User: 'người dùng',
  Destination: 'điểm đến',
  Review: 'đánh giá',
  Itinerary: 'lịch trình',
  ChatHistory: 'chat',
};

function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'vừa xong';
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  return `${Math.floor(diff / 86400)} ngày trước`;
}

const fetcher = async (key: string): Promise<NotificationsData> => {
  const since = key.split(':')[1] || undefined;
  const { data, error } = await adminApi.getNotifications(since);
  if (error || !data) throw new Error(error || 'Lỗi tải thông báo');
  return data as NotificationsData;
};

const LAST_READ_KEY = 'admin_notifications_last_read';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [since, setSince] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem(LAST_READ_KEY) || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  });
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { data } = useSWR<NotificationsData>(
    `admin/notifications:${since}`,
    fetcher,
    { refreshInterval: 45_000, revalidateOnFocus: true, dedupingInterval: 10_000 },
  );

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const markRead = () => {
    const now = new Date().toISOString();
    localStorage.setItem(LAST_READ_KEY, now);
    setSince(now);
  };

  const unread = data?.unreadCount ?? 0;
  const recent = data?.recent ?? [];

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative w-10 h-10 flex items-center justify-center rounded-xl bg-white/70 border border-gray-200 hover:border-violet-300 hover:bg-white transition-all shadow-sm"
        aria-label="Thông báo"
      >
        <span className="text-lg">🔔</span>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow-md shadow-red-500/40 ring-2 ring-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-gray-200 rounded-2xl shadow-2xl overflow-hidden z-30 animate-[fadeInScale_0.15s_ease]">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-gray-900">Hoạt động gần đây</p>
              <p className="text-xs text-gray-500">{unread > 0 ? `${unread} mục mới` : 'Đã xem hết'}</p>
            </div>
            {unread > 0 && (
              <button
                onClick={markRead}
                className="text-xs font-semibold text-violet-600 hover:text-violet-700"
              >
                Đánh dấu đã đọc
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {recent.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                Chưa có hoạt động nào.
              </div>
            ) : (
              <ul className="divide-y divide-gray-50">
                {recent.map((log) => (
                  <li key={log._id} className="px-4 py-3 hover:bg-gray-50 transition-colors">
                    <div className="flex items-start gap-3">
                      <span className="text-lg shrink-0 mt-0.5">{ACTION_ICON[log.action]}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-800 leading-snug">
                          <span className="font-semibold">{log.admin?.name || 'Admin'}</span>
                          {' '}đã {ACTION_LABEL[log.action]}{' '}
                          {MODEL_LABEL[log.targetModel]}
                          {log.targetLabel && (
                            <span className="font-medium text-gray-900"> &quot;{log.targetLabel}&quot;</span>
                          )}
                        </p>
                        <p className="text-[11px] text-gray-400 mt-0.5">{relativeTime(log.createdAt)}</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
