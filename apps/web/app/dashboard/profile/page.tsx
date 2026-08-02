'use client';
import { useState, useEffect } from 'react';
import { api } from '../../../lib/api-client';

interface UserProfile {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.auth.me()
      .then(data => {
        setProfile(data);
        setName(data.name);
      })
      .catch(() => setError('Failed to load profile'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || name === profile?.name) return;
    setSaving(true); setError(''); setSuccess(false);
    try {
      const updated = await api.auth.updateMe({ name: name.trim() });
      setProfile(updated);
      setName(updated.name);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const initials = profile?.name
    ? profile.name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
    : '?';

  const memberSince = profile?.createdAt
    ? new Date(profile.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '—';

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '40px 24px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Profile</h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 32 }}>
        Manage your account details
      </p>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--text-muted)' }}>
          <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
          Loading profile…
        </div>
      ) : (
        <>
          {/* Avatar + basic info */}
          <div className="card" style={{ padding: 28, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 20 }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%',
              background: 'var(--orange)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 22, fontWeight: 700, flexShrink: 0,
            }}>
              {initials}
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{profile?.name}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{profile?.email}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                Member since {memberSince}
              </div>
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <span style={{
                background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)',
                borderRadius: 20, padding: '4px 12px', fontSize: 11, fontWeight: 600,
                color: 'var(--text-secondary)',
              }}>
                Free Plan
              </span>
            </div>
          </div>

          {/* Edit name */}
          <div className="card" style={{ padding: 28, marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 20 }}>Account Details</h2>

            {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>⚠️ {error}</div>}
            {success && (
              <div className="alert alert-success" style={{ marginBottom: 16 }}>
                ✅ Name updated successfully
              </div>
            )}

            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label htmlFor="profile-name" className="form-label">Display Name</label>
                <input
                  id="profile-name"
                  type="text"
                  className="form-input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                  minLength={1}
                  maxLength={100}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Email Address</label>
                <input
                  type="email"
                  className="form-input"
                  value={profile?.email ?? ''}
                  readOnly
                  style={{ opacity: 0.6, cursor: 'not-allowed' }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Email cannot be changed
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || name.trim() === profile?.name || !name.trim()}
                >
                  {saving ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</> : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>

          {/* Plan info */}
          <div className="card" style={{ padding: 28 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Plan</h2>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Free Plan</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  Unlimited Zaps for personal use
                </div>
              </div>
              <span style={{
                background: 'rgba(255,120,0,0.12)', border: '1px solid rgba(255,120,0,0.3)',
                borderRadius: 20, padding: '4px 14px', fontSize: 11, fontWeight: 700,
                color: 'var(--orange)',
              }}>
                Active
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
