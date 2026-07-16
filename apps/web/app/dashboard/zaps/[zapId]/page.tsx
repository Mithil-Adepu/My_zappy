'use client';
import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { api, ZapWithSteps, ZapStep, Connector, AvailableAction, Connection } from '../../../../lib/api-client';

/** JSON-Schema shape for a single input field from the connector catalog. */
interface InputSchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  required?: boolean;
}
interface InputSchema {
  properties?: Record<string, InputSchemaProperty>;
  required?: string[];
}

interface Props { params: Promise<{ zapId: string }> }

const OPERATOR_LABELS: Record<string, string> = {
  eq: '=', neq: '≠', contains: 'contains', gt: '>', lt: '<', gte: '≥', lte: '≤', exists: 'exists',
};

export default function ZapBuilderPage({ params }: Props) {
  const { zapId } = use(params);
  const [zap, setZap] = useState<ZapWithSteps | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [actions, setActions] = useState<Record<string, AvailableAction[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  const [showAddAction, setShowAddAction] = useState(false);
  const [newActionConnector, setNewActionConnector] = useState('');
  const [newActionId, setNewActionId] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    Promise.all([
      api.zaps.get(zapId),
      api.connectors.list(),
      api.connections.list(),
    ]).then(([z, c, conn]) => {
      setZap(z); setConnectors(c); setConnections(conn);
      // Pre-load actions for each step's connector
      const actionLoads: Promise<void>[] = [];
      z.steps.forEach(step => {
        if (step.availableActionId) {
          const connectorId = step.availableActionId.split(':')[0];
          actionLoads.push(
            api.connectors.actions(connectorId).then(acts => setActions(a => ({ ...a, [connectorId]: acts })))
          );
        }
      });
      return Promise.all(actionLoads);
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zapId]);

  function openAddActionModal() {
    setShowAddAction(true);
  }

  async function handleNewActionConnectorChange(connectorId: string) {
    setNewActionConnector(connectorId);
    setNewActionId('');
    if (!connectorId) return;
    setActionLoading(true);
    try {
      const acts = await api.connectors.actions(connectorId);
      setActions(a => ({ ...a, [connectorId]: acts }));
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed loading actions'); }
    finally { setActionLoading(false); }
  }

  async function createActionStep(e: React.FormEvent) {
    e.preventDefault();
    if (!zap || !newActionId) return;
    setSaving(true);
    const position = zap.steps.length;
    try {
      const step = await api.zaps.addStep(zapId, {
        stepType: 'action', position,
        availableActionId: newActionId,
        config: {},
      });
      setZap({ ...zap, steps: [...zap.steps, step] });
      setActiveStep(step.id);
      setShowAddAction(false);
      setNewActionConnector('');
      setNewActionId('');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setSaving(false); }
  }

  async function addFilterStep() {
    if (!zap) return;
    const position = zap.steps.length;
    try {
      const step = await api.zaps.addStep(zapId, {
        stepType: 'filter', position,
        config: { conditions: [{ field: '', operator: 'eq', value: '' }], logic: 'AND' },
      });
      setZap({ ...zap, steps: [...zap.steps, step] });
      setActiveStep(step.id);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  async function updateStepConfig(step: ZapStep, config: Record<string, unknown>) {
    setSaving(true);
    try {
      await api.zaps.updateStep(zapId, step.id, { config });
      setZap(z => z ? { ...z, steps: z.steps.map(s => s.id === step.id ? { ...s, config } : s) } : z);
      setSuccess('Saved!'); setTimeout(() => setSuccess(''), 2000);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setSaving(false); }
  }

  async function updateStepConnection(step: ZapStep, connectionId: string) {
    try {
      await api.zaps.updateStep(zapId, step.id, { connectionId });
      setZap(z => z ? { ...z, steps: z.steps.map(s => s.id === step.id ? { ...s, connectionId } : s) } : z);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  async function deleteStep(stepId: string) {
    if (!confirm('Remove this step?')) return;
    try {
      await api.zaps.deleteStep(zapId, stepId);
      setZap(z => z ? { ...z, steps: z.steps.filter(s => s.id !== stepId).map((s, i) => ({ ...s, position: i })) } : z);
      setActiveStep(null);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
  }

  function stepIcon(step: ZapStep) {
    const connectorId = step.availableActionId?.split(':')[0] ?? step.availableTriggerId?.split(':')[0];
    if (connectorId === 'slack') return '💬';
    if (connectorId === 'razorpay') return '💳';
    if (connectorId === 'github') return '🐙';
    if (connectorId === 'webhooks') return '🪝';
    if (step.stepType === 'filter') return '🔀';
    return '⚙️';
  }

  function stepLabel(step: ZapStep) {
    if (step.stepType === 'trigger') return step.availableTrigger?.name ?? 'Trigger';
    if (step.stepType === 'filter') return 'Filter';
    return step.availableAction?.name ?? 'Action';
  }

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
      <div className="spinner" style={{ width: 40, height: 40 }} />
    </div>
  );
  if (!zap) return <div className="alert alert-error">Zap not found</div>;

  return (
    <>
      <div className="page-header">
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            <Link href="/dashboard/zaps" style={{ color: 'var(--orange)' }}>My Zaps</Link> / Builder
          </div>
          <h1 className="page-title">{zap.name}</h1>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {success && <span style={{ color: 'var(--green)', fontSize: 13, fontWeight: 600 }}>✓ {success}</span>}
          {saving && <div className="spinner" style={{ width: 16, height: 16 }} />}
          <Link href={`/dashboard/zaps/${zapId}/runs`}>
            <button className="btn btn-secondary">📊 View Runs</button>
          </Link>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 20 }}>⚠️ {error} <button onClick={() => setError('')} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>✕</button></div>}

      {showAddAction && (
        <div className="modal-backdrop" onClick={() => setShowAddAction(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2 className="modal-title">Add Action</h2>
            <form onSubmit={createActionStep} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="form-group">
                <label className="form-label">App</label>
                <select className="form-select" value={newActionConnector} onChange={e => handleNewActionConnectorChange(e.target.value)} required>
                  <option value="">— Select an app —</option>
                  {connectors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              {newActionConnector && (
                <div className="form-group">
                  <label className="form-label">Action Event</label>
                  {actionLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
                      <div className="spinner" style={{ width: 16, height: 16 }} />
                      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading actions…</span>
                    </div>
                  ) : (
                    <select className="form-select" value={newActionId} onChange={e => setNewActionId(e.target.value)} required>
                      <option value="">— Select an action —</option>
                      {(actions[newActionConnector] || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost" onClick={() => setShowAddAction(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? 'Adding…' : 'Add Action →'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="zap-builder">
        {zap.steps.sort((a, b) => a.position - b.position).map((step, idx) => (
          <div key={step.id}>
            <div className={`step-card ${activeStep === step.id ? 'active' : ''}`}>
              <div className="step-card-header" onClick={() => setActiveStep(activeStep === step.id ? null : step.id)}>
                <div className="step-number">{idx + 1}</div>
                <div className="step-connector-logo">{stepIcon(step)}</div>
                <div className="step-info">
                  <div className="step-type-label">{step.stepType}</div>
                  <div className="step-name">{stepLabel(step)}</div>
                </div>
                <span style={{ color: 'var(--text-muted)', fontSize: 18 }}>{activeStep === step.id ? '▲' : '▼'}</span>
              </div>

              {activeStep === step.id && (
                <div className="step-body" style={{ paddingTop: 16 }}>
                  {/* Trigger step */}
                  {step.stepType === 'trigger' && (() => {
                    const hooksBase = process.env.NEXT_PUBLIC_HOOKS_URL ?? 'http://localhost:3002';
                    const webhookUrl = `${hooksBase}/hooks/${zapId}/${step.id}`;
                    const connectorId = step.availableTriggerId?.split(':')[0] ?? '';
                    const isGitHub = connectorId === 'github';
                    const isCatchHook = step.availableTriggerId === 'webhooks:catch_hook';

                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                          {isGitHub
                            ? 'Point your GitHub repository webhook to this URL. GitHub will send the event in the request body.'
                            : isCatchHook
                            ? 'Point any app\'s webhook to this URL. Sign requests with HMAC-SHA256 using your webhook secret.'
                            : 'Point your app\'s webhook to this URL. Every POST triggers this Zap.'}
                        </p>

                        <div className="form-group">
                          <label className="form-label">Trigger Event</label>
                          <div className="code-block">{step.availableTrigger?.name ?? step.availableTriggerId}</div>
                        </div>

                        <div className="form-group">
                          <label className="form-label">Webhook URL</label>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <div className="code-block" style={{ flex: 1, userSelect: 'all', cursor: 'text', fontSize: 11 }}>
                              {webhookUrl}
                            </div>
                            <button
                              className="btn btn-secondary btn-sm"
                              style={{ flexShrink: 0 }}
                              onClick={() => navigator.clipboard.writeText(webhookUrl)}
                            >
                              📋 Copy
                            </button>
                          </div>
                        </div>

                        {step.webhookSecret && (
                          <div className="form-group">
                            <label className="form-label">Webhook Secret</label>
                            <div style={{ display: 'flex', gap: 8 }}>
                              <div className="code-block" style={{ flex: 1, fontSize: 11, userSelect: 'all', cursor: 'text', letterSpacing: '0.04em' }}>
                                {step.webhookSecret}
                              </div>
                              <button
                                className="btn btn-secondary btn-sm"
                                style={{ flexShrink: 0 }}
                                onClick={() => navigator.clipboard.writeText(step.webhookSecret!)}
                              >
                                📋 Copy
                              </button>
                            </div>
                            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                              {isGitHub
                                ? 'Paste this into GitHub → Settings → Webhooks → Secret.'
                                : 'Use this as the HMAC-SHA256 signing key in your provider\'s webhook settings.'}
                            </p>
                          </div>
                        )}

                        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '12px 14px', fontSize: 12 }}>
                          <div style={{ fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>Required headers</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {isGitHub ? (
                              <>
                                <div><code style={{ color: 'var(--orange)' }}>X-Hub-Signature-256</code> — HMAC-SHA256 of request body (prefixed <code>sha256=</code>)</div>
                                <div><code style={{ color: 'var(--orange)' }}>X-GitHub-Delivery</code> — GitHub-supplied unique delivery UUID</div>
                                <div><code style={{ color: 'var(--orange)' }}>X-GitHub-Event</code> — event type (e.g. <code>push</code>, <code>pull_request</code>)</div>
                              </>
                            ) : isCatchHook ? (
                              <>
                                <div><code style={{ color: 'var(--orange)' }}>X-Webhook-Signature</code> — HMAC-SHA256 of request body (hex)</div>
                                <div><code style={{ color: 'var(--orange)' }}>X-Webhook-Id</code> — unique event ID for deduplication</div>
                              </>
                            ) : (
                              <>
                                <div><code style={{ color: 'var(--orange)' }}>X-{connectorId.charAt(0).toUpperCase() + connectorId.slice(1)}-Signature</code> — HMAC-SHA256 of request body</div>
                                <div><code style={{ color: 'var(--orange)' }}>X-{connectorId.charAt(0).toUpperCase() + connectorId.slice(1)}-Event-Id</code> — unique event ID for deduplication</div>
                              </>
                            )}
                          </div>
                        </div>

                        {isGitHub && (
                          <div style={{ background: 'rgba(88, 166, 255, 0.08)', border: '1px solid rgba(88, 166, 255, 0.2)', borderRadius: 'var(--radius-md)', padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                            <strong>ℹ️ GitHub setup:</strong> Go to your repo → Settings → Webhooks → Add webhook.
                            Set Content type to <code>application/json</code>, paste the URL and secret above,
                            and select only the event type matching this trigger.
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Action step */}
                  {step.stepType === 'action' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {/* Connection picker */}
                      <div className="form-group">
                        <label className="form-label">Connection</label>
                        <select className="form-select"
                          value={step.connectionId ?? ''}
                          onChange={e => updateStepConnection(step, e.target.value)}>
                          <option value="">— Select connection —</option>
                          {connections
                            .filter(c => c.connectorId === step.availableActionId?.split(':')[0])
                            .map(c => <option key={c.id} value={c.id}>{c.label} ({c.connector.name})</option>)}
                        </select>
                      </div>

                      {/* Dynamic config fields */}
                      {step.availableAction?.inputSchema ? (
                        <>
                          {Object.entries((step.availableAction.inputSchema as InputSchema).properties ?? {}).map(([key, schema]) => (
                            <div className="form-group" key={key}>
                              <label className="form-label">{schema.title || key}</label>
                              {schema.type === 'string' && (key === 'text' || schema.title?.toLowerCase().includes('text') || schema.title?.toLowerCase().includes('description')) ? (
                                <textarea className="form-input" rows={3}
                                  placeholder={schema.description || `{{field.path}}`}
                                  value={(step.config[key] as string) ?? ''}
                                  onChange={e => updateStepConfig(step, { ...step.config, [key]: e.target.value })}
                                  style={{ resize: 'vertical' }} />
                              ) : (
                                <input type="text" className="form-input"
                                  placeholder={schema.description || `{{field.path}}`}
                                  value={(step.config[key] as string) ?? ''}
                                  onChange={e => updateStepConfig(step, { ...step.config, [key]: e.target.value })} />
                              )}
                            </div>
                          ))}
                        </>
                      ) : (
                        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                          Configure this action&apos;s fields using <code style={{ color: 'var(--orange)' }}>{'{{field.path}}'}</code> to reference trigger data.
                        </div>
                      )}
                    </div>
                  )}

                  {/* Filter step */}
                  {step.stepType === 'filter' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                        Only continue if these conditions are met. If not, run ends as <span className="badge badge-yellow">filtered</span>.
                      </p>
                      {((step.config.conditions ?? []) as Array<{ field: string; operator: string; value: unknown }>).map((cond, ci) => (
                        <div key={ci} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input type="text" className="form-input" placeholder="field.path" style={{ flex: 2 }}
                            value={cond.field}
                            onChange={e => {
                              const conditions = [...(step.config.conditions as typeof cond[])];
                              conditions[ci] = { ...conditions[ci], field: e.target.value };
                              updateStepConfig(step, { ...step.config, conditions });
                            }} />
                          <select className="form-select" style={{ flex: 1 }} value={cond.operator}
                            onChange={e => {
                              const conditions = [...(step.config.conditions as typeof cond[])];
                              conditions[ci] = { ...conditions[ci], operator: e.target.value };
                              updateStepConfig(step, { ...step.config, conditions });
                            }}>
                            {Object.entries(OPERATOR_LABELS).map(([op, label]) =>
                              <option key={op} value={op}>{label}</option>)}
                          </select>
                          <input type="text" className="form-input" placeholder="value" style={{ flex: 2 }}
                            value={String(cond.value ?? '')}
                            onChange={e => {
                              const conditions = [...(step.config.conditions as typeof cond[])];
                              conditions[ci] = { ...conditions[ci], value: e.target.value };
                              updateStepConfig(step, { ...step.config, conditions });
                            }} />
                          <button
                            className="btn btn-danger btn-sm"
                            style={{ flexShrink: 0, padding: '6px 10px' }}
                            title="Remove condition"
                            onClick={() => {
                              const conditions = (step.config.conditions as typeof cond[]).filter((_, i) => i !== ci);
                              updateStepConfig(step, { ...step.config, conditions });
                            }}>✕</button>
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            const existing = (step.config.conditions ?? []) as Array<{ field: string; operator: string; value: unknown }>;
                            updateStepConfig(step, { ...step.config, conditions: [...existing, { field: '', operator: 'eq', value: '' }] });
                          }}>+ Add Condition</button>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 'auto' }}>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Logic:</span>
                          {(['AND', 'OR'] as const).map(logic => (
                            <button key={logic}
                              className={`btn btn-sm ${(step.config.logic ?? 'AND') === logic ? 'btn-primary' : 'btn-secondary'}`}
                              style={{ padding: '4px 10px', fontSize: 11 }}
                              onClick={() => updateStepConfig(step, { ...step.config, logic })}>
                              {logic}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {step.stepType !== 'trigger' && (
                    <button className="btn btn-danger btn-sm" style={{ marginTop: 12 }} onClick={() => deleteStep(step.id)}>
                      🗑 Remove step
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Connector line between steps */}
            {idx < zap.steps.length - 1 && (
              <div style={{ width: 2, height: 20, background: 'var(--border)', margin: '0 auto', borderRadius: 2 }} />
            )}
          </div>
        ))}

        {/* Add step buttons */}
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button className="step-add-btn" id="add-action-btn" onClick={openAddActionModal}>
            ＋ Add Action
          </button>
          <button className="step-add-btn" id="add-filter-btn" onClick={addFilterStep} style={{ borderStyle: 'dashed' }}>
            🔀 Add Filter
          </button>
        </div>
      </div>
    </>
  );
}
