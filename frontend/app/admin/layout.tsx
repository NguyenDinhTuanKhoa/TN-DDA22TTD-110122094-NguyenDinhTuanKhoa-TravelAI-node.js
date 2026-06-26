'use client';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useAuth } from '../context/AuthContext';
import ToastContainer from './_components/Toast';
import Breadcrumbs from './_components/Breadcrumbs';
import { LayoutSkeleton } from './_components/AdminSkeleton';
import GlobalSearch from './_components/GlobalSearch';
import NotificationBell from './_components/NotificationBell';

interface MenuItem {
  name: string;
  href: string;
  icon: string;
  section?: string;
}

const menuItems: MenuItem[] = [
  { name: 'Dashboard', href: '/admin', icon: '📊', section: 'Tổng quan' },
  { name: 'Điểm đến', href: '/admin/destinations', icon: '🏝️', section: 'Nội dung' },
  { name: 'Tour', href: '/admin/tours', icon: '🧳', section: 'Nội dung' },
  { name: 'Đánh giá', href: '/admin/reviews', icon: '⭐', section: 'Nội dung' },
  { name: 'Lịch trình', href: '/admin/itineraries', icon: '🗺️', section: 'Nội dung' },
  { name: 'Người dùng', href: '/admin/users', icon: '👥', section: 'Quản lý' },
  { name: 'Chat history', href: '/admin/chats', icon: '💬', section: 'Quản lý' },
];

function getIcon(name: string, active: boolean) {
  const colorClass = active ? 'text-white' : 'text-gray-500 group-hover:text-gray-800';
  switch (name) {
    case 'Dashboard':
      return (
        <svg className={`w-5 h-5 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      );
    case 'Điểm đến':
      return (
        <svg className={`w-5 h-5 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25s-7.5-4.108-7.5-11.25a7.5 7.5 0 1 1 15 0Z" />
        </svg>
      );
    case 'Tour':
      return (
        <svg className={`w-5 h-5 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 0 0 .75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 0 0-3.413-.387m4.5 8.006c-.194.165-.42.295-.673.38A23.978 23.978 0 0 1 12 15.75c-2.648 0-5.195-.429-7.577-1.22a2.016 2.016 0 0 1-.673-.38m0 0A2.18 2.18 0 0 1 3 12.489V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 0 1 3.413-.387m7.5 0V5.25A2.25 2.25 0 0 0 13.5 3h-3a2.25 2.25 0 0 0-2.25 2.25v.894m7.5 0a48.667 48.667 0 0 0-7.5 0M12 12.75h.008v.008H12v-.008Z" />
        </svg>
      );
    case 'Đánh giá':
      return (
        <svg className={`w-5 h-5 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499c.195-.558.979-.558 1.174 0l1.82 5.101a.75.75 0 0 0 .707.502h5.362c.594 0 .841.767.36.109l-4.338 3.14a.75.75 0 0 0-.272.842l1.624 5.067c.181.566-.463 1.033-.94.688l-4.338-3.14a.75.75 0 0 0-.882 0l-4.338 3.14c-.477.345-1.121-.122-.94-.688l1.624-5.067a.75.75 0 0 0-.272-.842l-4.338-3.14c-.482-.35-.235-1.11.36-1.11h5.362a.75.75 0 0 0 .707-.502l1.82-5.101Z" />
        </svg>
      );
    case 'Lịch trình':
      return (
        <svg className={`w-5 h-5 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.446 6.002-3.461a1.124 1.124 0 0 0 .502-.964V3.833a1.125 1.125 0 0 0-1.597-.999l-6.002 3.001a1.125 1.125 0 0 1-1.008 0L7.503 2.834a1.125 1.125 0 0 0-1.008 0L.493 5.834A1.125 1.125 0 0 0 0 6.833v11.722a1.125 1.125 0 0 0 1.597.999l6.002-3.001a1.125 1.125 0 0 1 1.008 0Zm0 0-6-3m0 0v11.25m6-11.25v11.25" />
        </svg>
      );
    case 'Người dùng':
      return (
        <svg className={`w-5 h-5 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
        </svg>
      );
    case 'Chat history':
      return (
        <svg className={`w-5 h-5 ${colorClass}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a.75.75 0 0 1-1.074-.765 7.99 7.99 0 0 0 1.257-3.241C4.343 15.65 3 13.98 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
        </svg>
      );
    default:
      return null;
  }
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  useEffect(() => {
    if (!loading && (!user || user.role !== 'admin')) {
      router.push('/login');
    }
  }, [user, loading, router]);

  if (loading) {
    return <LayoutSkeleton />;
  }

  if (!user || user.role !== 'admin') {
    return <LayoutSkeleton />;
  }

  const isActive = (href: string) => {
    if (href === '/admin') return pathname === '/admin';
    return pathname?.startsWith(href);
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex font-sans">
      <ToastContainer />

      {/* ── SIDEBAR ───────────────────────────────────────────────────── */}
      <aside
        className={`${sidebarOpen ? 'w-64' : 'w-20'} bg-white border-r border-gray-100 text-gray-600 transition-all duration-300 flex flex-col fixed h-screen z-30`}
      >
        {/* Logo */}
        <div className="p-4 border-b border-gray-100 shrink-0 h-16 flex items-center">
          <Link href="/admin" className="flex items-center gap-3">
            <Image src="/logonew.png" alt="Logo" width={36} height={36} className="rounded-xl shrink-0" />
            {sidebarOpen && (
              <span className="text-lg font-bold tracking-tight text-gray-800">
                Travel<span className="text-blue-600">AI</span>
                <span className="ml-1.5 text-[10px] uppercase tracking-widest text-gray-400 align-top">Admin</span>
              </span>
            )}
          </Link>
        </div>

        {/* Menu */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-1 scrollbar-thin">
          <ul className="space-y-1">
            {menuItems.map((item) => {
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`flex items-center ${
                      sidebarOpen ? 'gap-3.5 px-4 py-3 mx-1' : 'justify-center w-11 h-11 mx-auto'
                    } rounded-xl transition-all duration-200 group relative ${
                      active
                        ? 'bg-blue-600 text-white font-medium shadow-sm shadow-blue-100'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`}
                    title={!sidebarOpen ? item.name : undefined}
                  >
                    <span className="shrink-0 transition-transform duration-200 group-hover:scale-105">
                      {getIcon(item.name, active)}
                    </span>
                    {sidebarOpen && <span className="text-sm tracking-wide">{item.name}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-gray-100 space-y-1 shrink-0">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className={`w-full flex items-center ${
              sidebarOpen ? 'justify-start gap-3.5 px-4' : 'justify-center w-11 h-11 mx-auto'
            } py-2.5 hover:bg-gray-100 rounded-xl transition-all duration-200 text-gray-600 group`}
            title={sidebarOpen ? 'Thu gọn' : 'Mở rộng'}
          >
            <span className="shrink-0 transition-transform duration-200 group-hover:scale-105">
              {sidebarOpen ? (
                <svg className="w-5 h-5 text-gray-500 group-hover:text-gray-800" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.75 19.5l-7.5-7.5 7.5-7.5m-6 15L5.25 12l7.5-7.5" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-gray-500 group-hover:text-gray-800" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 4.5l7.5 7.5-7.5 7.5m-6-15l7.5 7.5-7.5 7.5" />
                </svg>
              )}
            </span>
            {sidebarOpen && <span className="text-sm tracking-wide">Thu gọn</span>}
          </button>
          <Link
            href="/"
            className={`flex items-center ${
              sidebarOpen ? 'justify-start gap-3.5 px-4' : 'justify-center w-11 h-11 mx-auto'
            } py-2.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 rounded-xl transition-all duration-200 group`}
            title="Về trang chủ"
          >
            <span className="shrink-0 transition-transform duration-200 group-hover:scale-105">
              <svg className="w-5 h-5 text-gray-500 group-hover:text-gray-800" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
              </svg>
            </span>
            {sidebarOpen && <span className="text-sm tracking-wide">Về trang chủ</span>}
          </Link>
        </div>
      </aside>

      {/* ── MAIN ──────────────────────────────────────────────────────── */}
      <main className={`flex-1 ${sidebarOpen ? 'ml-64' : 'ml-20'} transition-all duration-300 min-h-screen flex flex-col`}>
        {/* Header */}
        <header className="bg-white sticky top-0 z-20 shrink-0 border-b border-gray-100 h-16 flex items-center">
          <div className="px-6 py-3 flex items-center gap-4 w-full">
            <div className="min-w-0 shrink-0">
              <h1 className="text-base font-semibold text-gray-800 leading-tight">Admin Panel</h1>
              <div className="mt-0.5 flex items-center gap-2">
                <Breadcrumbs />
              </div>
            </div>

            <div className="flex-1 flex justify-center">
              <GlobalSearch />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <NotificationBell />

              <div className="relative">
                <button
                  onClick={() => setUserMenuOpen(!userMenuOpen)}
                  className="flex items-center gap-2 hover:bg-gray-50 rounded-full pl-2 pr-4 py-1.5 transition-colors border border-gray-100"
                >
                  <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-sm">
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="text-left hidden lg:block">
                    <p className="text-sm font-semibold text-gray-700 leading-tight">{user.name}</p>
                    <p className="text-[10px] text-gray-500">admin@travelai.com</p>
                  </div>
                  <span className="text-gray-400 text-xs ml-1">▼</span>
                </button>
                {userMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setUserMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-2 w-48 bg-white border border-gray-200 rounded-xl shadow-xl z-20 overflow-hidden animate-[fadeInScale_0.15s_ease]">
                      <div className="px-4 py-3 border-b border-gray-100">
                        <p className="text-sm font-semibold text-gray-900 truncate">{user.name}</p>
                        <p className="text-xs text-gray-500 truncate">{user.email}</p>
                      </div>
                      <Link
                        href="/"
                        onClick={() => setUserMenuOpen(false)}
                        className="block px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        🏠 Về trang chủ
                      </Link>
                      <button
                        onClick={() => { logout(); router.push('/login'); }}
                        className="w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors border-t border-gray-100"
                      >
                        🚪 Đăng xuất
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>

        <div className="p-6 flex-1">{children}</div>
      </main>
    </div>
  );
}
