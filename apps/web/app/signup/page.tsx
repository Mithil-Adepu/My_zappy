'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../lib/api-client';

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const { token } = await api.auth.signup(form);
      localStorage.setItem('zapier_token', token);
      document.cookie = `zapier_token=${token}; path=/; max-age=604800; SameSite=Lax`;
      router.push('/dashboard/zaps');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Signup failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <div className="sidebar-logo-icon">⚡</div>
            <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.04em' }}>ZapFlow</span>
          </div>
          <p style={{ color: 'var(--text-secondary)', marginTop: 8, fontSize: 14 }}>Create your account</p>
        </div>
        <div className="card" style={{ padding: 32 }}>
          {error && <div className="alert alert-error" style={{ marginBottom: 20 }}>⚠️ {error}</div>}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="form-group">
              <label className="form-label">Name</label>
              <input id="name" type="text" className="form-input" placeholder="Your name" value={form.name} onChange={set('name')} required />
            </div>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input id="signup-email" type="email" className="form-input" placeholder="you@example.com" value={form.email} onChange={set('email')} required />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input id="signup-password" type="password" className="form-input" placeholder="Min 8 characters" value={form.password} onChange={set('password')} minLength={8} required />
            </div>
            <button id="signup-btn" type="submit" className="btn btn-primary btn-lg" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
              {loading ? <><div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Creating account…</> : 'Create account →'}
            </button>
          </form>
        </div>
        <p style={{ textAlign: 'center', marginTop: 20, color: 'var(--text-secondary)', fontSize: 13 }}>
          Already have an account?{' '}<Link href="/login" style={{ color: 'var(--orange)', fontWeight: 600 }}>Sign in</Link>
        </p>
      </div>
    </div>
  );
}
