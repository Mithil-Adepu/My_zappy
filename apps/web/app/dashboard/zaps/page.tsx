'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, Zap, Connector } from '../../../lib/api-client';

export default function ZapsPage() {
  const router = useRouter();
  const [zaps, setZaps] = useState<Zap[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState('');
  
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [triggers, setTriggers] = useState<import('../../../lib/api-client').AvailableTrigger[]>([]);
  const [selectedConnector, setSelectedConnector] = useState('');
  const [selectedTrigger, setSelectedTrigger] = useState('');

  useEffect(() => { loadZaps(); }, []);

  async function loadZaps() {
    try { setZaps(await api.zaps.list()); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setLoading(false); }
  }

  async function toggleActive(zap: Zap) {
    try {
      await api.zaps.update(zap.id, { isActive: !zap.isActive });
      setZaps(zaps.map(z => z.id === zap.id ? { ...z, isActive: !z.isActive } : z));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  async function deleteZap(id: string) {
    if (!confirm('Delete this zap? This cannot be undone.')) return;
    try {
      await api.zaps.delete(id);
      setZaps(zaps.filter(z => z.id !== id));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  async function createZap(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !selectedTrigger) {
      setError('Please provide a name and select a trigger.');
      return;
    }
    setCreating(true);
    try {
      const zap = await api.zaps.create({
        name: newName.trim(),
        steps: [{
          stepType: 'trigger', position: 0,
          availableTriggerId: selectedTrigger,
          config: {},
        }],
      });
      router.push(`/dashboard/zaps/${zap.id}`);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setCreating(false); }
  }

  async function openNewZapModal() {
    setShowNew(true);
    try {
      const conn = await api.connectors.list();
      setConnectors(conn);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed loading connectors'); }
  }

  async function handleConnectorChange(connectorId: string) {
    setSelectedConnector(connectorId);
    setSelectedTrigger('');
    if (!connectorId) {
      setTriggers([]);
      return;
    }
    try {
      const trigs = await api.connectors.triggers(connectorId);
      setTriggers(trigs);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed loading triggers'); }
  }

  function statusBadge(active: boolean) {
    return active
      ? <span className="badge badge-green">● Active</span>
      : <span className="badge badge-gray">○ Inactive</span>;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">My Zaps</h1>
          <p className="page-subtitle">Automated workflows connecting your apps</p>
        </div>
        <button id="new-zap-btn" className="btn btn-primary" onClick={openNewZapModal}>
          ⚡ New Zap
        </button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 20 }}>⚠️ {error}</div>}

      {/* New zap modal */}
      {showNew && (
        <div className="modal-backdrop" onClick={() => setShowNew(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Create new Zap</h2>
            <form onSubmit={createZap} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="form-label">Zap name</label>
                <input id="zap-name-input" autoFocus type="text" className="form-input"
                  placeholder="e.g. Razorpay → Slack notification"
                  value={newName} onChange={e => setNewName(e.target.value)} required />
              </div>
              <div className="form-group">
                <label className="form-label">Trigger App</label>
                <select className="form-select" value={selectedConnector} onChange={e => handleConnectorChange(e.target.value)} required>
                  <option value="">— Select an app —</option>
                  {connectors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              {selectedConnector && (
                <div className="form-group">
                  <label className="form-label">Trigger Event</label>
                  <select className="form-select" value={selectedTrigger} onChange={e => setSelectedTrigger(e.target.value)} required>
                    <option value="">— Select an event —</option>
                    {triggers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost" onClick={() => setShowNew(false)}>Cancel</button>
                <button id="create-zap-submit" type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? 'Creating…' : 'Create Zap →'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" style={{ width: 36, height: 36 }} /></div>
      ) : zaps.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">⚡</div>
          <div className="empty-state-title">No zaps yet</div>
          <div className="empty-state-desc">Create your first zap to start automating workflows between your apps.</div>
          <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={openNewZapModal}>Create your first Zap</button>
        </div>
      ) : (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Steps</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {zaps.map(zap => (
                <tr key={zap.id}>
                  <td>
                    <Link href={`/dashboard/zaps/${zap.id}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                      {zap.name}
                    </Link>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>{zap._count?.steps ?? '—'} steps</td>
                  <td>{statusBadge(zap.isActive)}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{new Date(zap.createdAt).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label className="toggle">
                        <input type="checkbox" checked={zap.isActive} onChange={() => toggleActive(zap)} />
                        <span className="toggle-slider" />
                      </label>
                      <Link href={`/dashboard/zaps/${zap.id}/runs`}>
                        <button className="btn btn-ghost btn-sm">Runs</button>
                      </Link>
                      <button className="btn btn-danger btn-sm" onClick={() => deleteZap(zap.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
