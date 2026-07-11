'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../lib/api-client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const { token } = await api.auth.login({ email, password });
      localStorage.setItem('zapier_token', token);
      document.cookie = `zapier_token=${token}; path=/; max-age=604800; SameSite=Lax`;
      router.push('/dashboard/zaps');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'var(--bg-base)' }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <div className="sidebar-logo-icon">⚡</div>
            <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.04em' }}>ZapFlow</span>
          </div>
          <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 14 }}>Sign in to your account</p>
        </div>

        <div className="card" style={{ padding: 32 }}>
          {error && <div className="alert alert-error" style={{ marginBottom: 20 }}>⚠️ {error}</div>}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input id="email" type="email" className="form-input" placeholder="you@example.com"
                value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input id="password" type="password" className="form-input" placeholder="••••••••"
                value={password} onChange={e => setPassword(e.target.value)} required />
            </div>
            <button id="login-btn" type="submit" className="btn btn-primary btn-lg" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
              {loading ? <><div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Signing in…</> : 'Sign in →'}
            </button>
          </form>
        </div>

        <p style={{ textAlign: 'center', marginTop: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
          Don&apos;t have an account?{' '}
          <Link href="/signup" style={{ color: 'var(--orange)', fontWeight: 600 }}>Sign up</Link>
        </p>
      </div>
    </div>
  );
}
