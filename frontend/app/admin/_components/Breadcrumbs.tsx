'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LABELS: Record<string, string> = {
  admin: 'Admin',
  destinations: 'Điểm đến',
  reviews: 'Đánh giá',
  itineraries: 'Lịch trình',
  users: 'Người dùng',
  chats: 'Chat history',
};

function label(segment: string) {
  return LABELS[segment] || segment.charAt(0).toUpperCase() + segment.slice(1);
}

export default function Breadcrumbs() {
  const pathname = usePathname() || '';
  const segments = pathname.split('/').filter(Boolean);

  if (segments.length <= 1) return null;

  const crumbs = segments.map((seg, i) => {
    const href = '/' + segments.slice(0, i + 1).join('/');
    const isLast = i === segments.length - 1;
    return { href, label: label(seg), isLast };
  });

  return (
    <nav aria-label="Breadcrumb" className="flex items-center text-xs text-gray-500">
      {crumbs.map((c, i) => (
        <span key={c.href} className="flex items-center">
          {i > 0 && <span className="mx-2 text-gray-300">/</span>}
          {c.isLast ? (
            <span className="font-semibold text-gray-700">{c.label}</span>
          ) : (
            <Link href={c.href} className="hover:text-violet-600 transition-colors">
              {c.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
