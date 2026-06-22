'use client';
import Link from 'next/link';

interface Action {
  href: string;
  icon: string;
  label: string;
  hint: string;
  accent: 'sky' | 'violet' | 'orange' | 'emerald';
}

const ACTIONS: Action[] = [
  { href: '/admin/destinations', icon: '🏝️', label: 'Quản lý điểm đến', hint: 'Thêm, sửa, xóa', accent: 'emerald' },
  { href: '/admin/users', icon: '👥', label: 'Quản lý người dùng', hint: 'Phân quyền, ban', accent: 'sky' },
  { href: '/admin/reviews', icon: '⭐', label: 'Kiểm duyệt đánh giá', hint: 'Xem các review mới', accent: 'orange' },
];

const accentClass: Record<Action['accent'], string> = {
  sky: 'from-sky-500/10 to-sky-500/5 text-sky-700 border-sky-100 hover:border-sky-200 hover:from-sky-500/20',
  violet: 'from-violet-500/10 to-violet-500/5 text-violet-700 border-violet-100 hover:border-violet-200 hover:from-violet-500/20',
  orange: 'from-orange-500/10 to-orange-500/5 text-orange-700 border-orange-100 hover:border-orange-200 hover:from-orange-500/20',
  emerald: 'from-emerald-500/10 to-emerald-500/5 text-emerald-700 border-emerald-100 hover:border-emerald-200 hover:from-emerald-500/20',
};

export default function QuickActions() {
  return (
    <div className="grid grid-cols-2 gap-4">
      {ACTIONS.map((a) => (
        <Link
          key={a.href}
          href={a.href}
          className="group bg-white border border-gray-100 rounded-2xl px-4 py-4 flex flex-col items-center justify-center text-center transition-all hover:shadow-md hover:border-gray-200"
        >
          <div className="w-10 h-10 mb-2 flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">
            {a.icon}
          </div>
          <div className="min-w-0 w-full">
            <p className="text-sm font-semibold text-gray-800 truncate">{a.label}</p>
            <p className="text-xs text-gray-400 truncate mt-1">{a.hint}</p>
          </div>
        </Link>
      ))}
    </div>
  );
}
