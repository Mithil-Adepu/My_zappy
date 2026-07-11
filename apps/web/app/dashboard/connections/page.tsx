'use client';
import { useEffect, useState } from 'react';
import { api, Connection, Connector } from '../../../lib/api-client';

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showApiKey, setShowApiKey] = useState<string | null>(null);
  const [apiKeyForm, setApiKeyForm] = useState({ label: '', apiKey: '', apiSecret: '' });
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    Promise.all([api.connections.list(), api.connectors.list()])
      .then(([c, conn]) => { setConnections(c); setConnectors(conn); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function connectOAuth(connectorId: string) {
    try {
      const { authUrl } = await api.connections.startOAuth(connectorId);
      window.location.href = authUrl;
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  async function connectApiKey(connectorId: string) {
    if (!apiKeyForm.label || !apiKeyForm.apiKey) return;
    setConnecting(true);
    try {
      const conn = await api.connections.connectApiKey({ connectorId, ...apiKeyForm });
      setConnections(c => [...c, conn]);
      setShowApiKey(null);
      setApiKeyForm({ label: '', apiKey: '', apiSecret: '' });
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setConnecting(false); }
  }

  async function deleteConnection(id: string) {
    if (!confirm('Disconnect this app? Zaps using it will fail.')) return;
    try {
      await api.connections.delete(id);
      setConnections(c => c.filter(x => x.id !== id));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  const connectedIds = new Set(connections.map(c => c.connectorId));

  const AUTH_ICONS: Record<string, string> = {
    slack: '💬', razorpay: '💳', notion: '📝', gmail: '📧',
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Connections</h1>
          <p className="page-subtitle">Apps connected to your ZapFlow account</p>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 20 }}>⚠️ {error}</div>}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" style={{ width: 36, height: 36 }} /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {/* Left: available connectors */}
          <div>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 14, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Available Apps
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {connectors.map(connector => {
                const isConnected = connectedIds.has(connector.id);
                return (
                  <div key={connector.id} className="card" style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div className="step-connector-logo" style={{ width: 40, height: 40, fontSize: 22 }}>
                      {AUTH_ICONS[connector.id] ?? '🔌'}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{connector.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                        {connector.authType === 'oauth' ? 'OAuth 2.0' : 'API Key'}
                      </div>
                    </div>
                    {isConnected ? (
                      <span className="badge badge-green">✓ Connected</span>
                    ) : connector.authType === 'oauth' ? (
                      <button id={`connect-${connector.id}`} className="btn btn-primary btn-sm" onClick={() => connectOAuth(connector.id)}>
                        Connect
                      </button>
                    ) : (
                      <button id={`connect-${connector.id}`} className="btn btn-secondary btn-sm" onClick={() => setShowApiKey(connector.id)}>
                        Add Key
                      </button>
                    )}
                  </div>
                );
              })}
              {connectors.length === 0 && (
                <div className="empty-state">
                  <div className="empty-state-icon">🔌</div>
                  <div className="empty-state-title">No connectors available</div>
                  <div className="empty-state-desc">Run the seed script to populate the connector catalog.</div>
                </div>
              )}
            </div>
          </div>

          {/* Right: active connections */}
          <div>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 14, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Active Connections
            </h2>
            {connections.length === 0 ? (
              <div className="empty-state" style={{ padding: 40 }}>
                <div className="empty-state-icon">🔌</div>
                <div className="empty-state-title">No connections yet</div>
                <div className="empty-state-desc">Connect an app to start using it in your Zaps.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {connections.map(conn => (
                  <div key={conn.id} className="card" style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div className="step-connector-logo" style={{ fontSize: 20 }}>
                      {AUTH_ICONS[conn.connectorId] ?? '🔌'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{conn.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{conn.connector.name} · {conn.connector.authType}</div>
                      {conn.expiresAt && (
                        <div style={{ fontSize: 11, color: new Date(conn.expiresAt) < new Date() ? 'var(--red)' : 'var(--green)', marginTop: 2 }}>
                          {new Date(conn.expiresAt) < new Date() ? '⚠ Expired' : '✓ Valid'} until {new Date(conn.expiresAt).toLocaleDateString()}
                        </div>
                      )}
                    </div>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteConnection(conn.id)}>Disconnect</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* API key modal */}
      {showApiKey && (
        <div className="modal-backdrop" onClick={() => setShowApiKey(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Connect {connectors.find(c => c.id === showApiKey)?.name}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="form-group">
                <label className="form-label">Label</label>
                <input type="text" className="form-input" placeholder="e.g. My Razorpay Account"
                  value={apiKeyForm.label} onChange={e => setApiKeyForm(f => ({ ...f, label: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">API Key</label>
                <input type="password" className="form-input" placeholder="rzp_live_..."
                  value={apiKeyForm.apiKey} onChange={e => setApiKeyForm(f => ({ ...f, apiKey: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">API Secret <span style={{ color: 'var(--text-muted)' }}>(optional)</span></label>
                <input type="password" className="form-input" placeholder="Leave blank if not needed"
                  value={apiKeyForm.apiSecret} onChange={e => setApiKeyForm(f => ({ ...f, apiSecret: e.target.value }))} />
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
                <button className="btn btn-ghost" onClick={() => setShowApiKey(null)}>Cancel</button>
                <button id="save-api-key-btn" className="btn btn-primary" disabled={connecting} onClick={() => connectApiKey(showApiKey!)}>
                  {connecting ? 'Connecting…' : 'Connect →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
