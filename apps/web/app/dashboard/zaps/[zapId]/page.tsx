'use client';
import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { api, ZapWithSteps, ZapStep, Connector, AvailableAction, Connection } from '../../../../lib/api-client';

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
          if (!actions[connectorId]) {
            actionLoads.push(
              api.connectors.actions(connectorId).then(acts => setActions(a => ({ ...a, [connectorId]: acts })))
            );
          }
        }
      });
      return Promise.all(actionLoads);
    }).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [zapId]);

  async function addActionStep() {
    if (!zap) return;
    const position = zap.steps.length;
    try {
      const step = await api.zaps.addStep(zapId, {
        stepType: 'action', position,
        availableActionId: 'slack:send-message',
        config: { channel: '', text: '' },
      });
      setZap({ ...zap, steps: [...zap.steps, step] });
      setActiveStep(step.id);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
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
    const c = connectors.find(c => c.id === connectorId);
    if (c?.id === 'slack') return '💬';
    if (c?.id === 'razorpay') return '💳';
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
                  {step.stepType === 'trigger' && (
                    <div>
                      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
                        This step listens for incoming webhooks. Share the webhook URL with the trigger app.
                      </p>
                      <div className="form-group">
                        <label className="form-label">Trigger</label>
                        <div className="code-block">{step.availableTrigger?.name ?? step.availableTriggerId}</div>
                      </div>
                    </div>
                  )}

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
                      {step.availableAction?.name === 'Send Message' || step.availableActionId === 'slack:send-message' ? (
                        <>
                          <div className="form-group">
                            <label className="form-label">Channel</label>
                            <input type="text" className="form-input" placeholder="#general or C1234567"
                              value={(step.config.channel as string) ?? ''}
                              onChange={e => updateStepConfig(step, { ...step.config, channel: e.target.value })} />
                          </div>
                          <div className="form-group">
                            <label className="form-label">Message Text</label>
                            <textarea className="form-input" rows={3}
                              placeholder="Use {{payload.payment.entity.amount}} to insert trigger data"
                              value={(step.config.text as string) ?? ''}
                              onChange={e => updateStepConfig(step, { ...step.config, text: e.target.value })}
                              style={{ resize: 'vertical' }} />
                          </div>
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
                        </div>
                      ))}
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
          <button className="step-add-btn" id="add-action-btn" onClick={addActionStep}>
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
