'use client';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [user, setUser] = useState<{ name: string; email: string } | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('zapier_token');
    if (!token) { router.replace('/login'); return; }
    // Decode JWT payload (no verify needed client-side — just for display)
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      setUser({ name: payload.sub ?? 'User', email: '' });
    } catch { setUser({ name: 'User', email: '' }); }
  }, [router]);

  function logout() {
    localStorage.removeItem('zapier_token');
    document.cookie = 'zapier_token=; path=/; max-age=0';
    router.push('/login');
  }

  const navItems = [
    { href: '/dashboard/zaps',        icon: '⚡', label: 'My Zaps' },
    { href: '/dashboard/connections',  icon: '🔌', label: 'Connections' },
  ];

  return (
    <div className="layout">
      {/* Sidebar */}
      <nav className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">⚡</div>
          <span className="sidebar-logo-text">ZapFlow</span>
        </div>

        <div className="nav-section">
          <div className="nav-section-label">Workspace</div>
          {navItems.map(item => (
            <Link key={item.href} href={item.href}>
              <div className={`nav-item ${path.startsWith(item.href) ? 'active' : ''}`}>
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </div>
            </Link>
          ))}
        </div>

        <div style={{ marginTop: 'auto', padding: '16px 12px', borderTop: '1px solid var(--border)' }}>
          <div style={{ padding: '10px 12px', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{user?.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Free plan</div>
          </div>
          <button onClick={logout} className="nav-item" style={{ width: '100%', color: 'var(--red)' }}>
            <span>🚪</span><span>Sign out</span>
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
