'use client';
import { useEffect, useState, use } from 'react';
import Link from 'next/link';
import { api, ZapRun, RunDetail } from '../../../../../lib/api-client';

interface Props { params: Promise<{ zapId: string }> }

const STATUS_CONFIG: Record<string, { badge: string; dot: string; emoji: string }> = {
  queued:      { badge: 'badge-gray',   dot: 'pending',   emoji: '⏳' },
  completed:   { badge: 'badge-green',  dot: 'completed', emoji: '✓' },
  failed:      { badge: 'badge-red',    dot: 'failed',    emoji: '✕' },
  filtered:    { badge: 'badge-yellow', dot: 'ambiguous', emoji: '⊘' },
  in_progress: { badge: 'badge-blue',   dot: 'processing', emoji: '⟳' },
  processing:  { badge: 'badge-blue',   dot: 'processing', emoji: '⟳' },
  ambiguous:   { badge: 'badge-yellow', dot: 'ambiguous', emoji: '?' },
};

export default function RunsPage({ params }: Props) {
  const { zapId } = use(params);
  const [runs, setRuns] = useState<ZapRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { loadRuns(page); }, [zapId, page]);

  async function loadRuns(p: number) {
    setLoading(true);
    try {
      const data = await api.runs.list(zapId, p);
      setRuns(data.runs); setTotal(data.total);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setLoading(false); }
  }

  async function viewRun(runId: string) {
    setRunLoading(true);
    try { setSelectedRun(await api.runs.get(runId)); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setRunLoading(false); }
  }

  function fmt(d: string) { return new Date(d).toLocaleString(); }
  function duration(start: string, end: string | null) {
    if (!end) return '—';
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            <Link href="/dashboard/zaps" style={{ color: 'var(--orange)' }}>My Zaps</Link>
            {' / '}
            <Link href={`/dashboard/zaps/${zapId}`} style={{ color: 'var(--orange)' }}>Builder</Link>
            {' / Runs'}
          </div>
          <h1 className="page-title">Run History</h1>
          <p className="page-subtitle">{total} total runs</p>
        </div>
        <button className="btn btn-secondary" onClick={() => loadRuns(page)}>↻ Refresh</button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: 20 }}>⚠️ {error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: selectedRun ? '1fr 1fr' : '1fr', gap: 20 }}>
        {/* Run list */}
        <div>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" style={{ width: 36, height: 36 }} /></div>
          ) : runs.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📊</div>
              <div className="empty-state-title">No runs yet</div>
              <div className="empty-state-desc">Trigger a webhook to see run history here.</div>
            </div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr><th>Status</th><th>Started</th><th>Duration</th><th>Steps</th><th></th></tr>
                </thead>
                <tbody>
                  {runs.map(run => {
                    const cfg = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.in_progress;
                    return (
                      <tr key={run.id} style={{ cursor: 'pointer' }} onClick={() => viewRun(run.id)}>
                        <td><span className={`badge ${cfg.badge}`}>{cfg.emoji} {run.status}</span></td>
                        <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{fmt(run.startedAt)}</td>
                        <td style={{ color: 'var(--text-secondary)' }}>{duration(run.startedAt, run.completedAt)}</td>
                        <td style={{ color: 'var(--text-secondary)' }}>{run._count.zapRunSteps}</td>
                        <td><button className="btn btn-ghost btn-sm">Details →</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {total > 20 && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>← Prev</button>
              <span style={{ padding: '6px 12px', color: 'var(--text-secondary)', fontSize: 13 }}>Page {page}</span>
              <button className="btn btn-secondary btn-sm" onClick={() => setPage(p => p + 1)} disabled={page * 20 >= total}>Next →</button>
            </div>
          )}
        </div>

        {/* Run detail panel */}
        {selectedRun && (
          <div className="card" style={{ position: 'sticky', top: 0, maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Run Detail</div>
                <span className={`badge ${STATUS_CONFIG[selectedRun.status]?.badge ?? 'badge-gray'}`} style={{ marginTop: 4 }}>
                  {selectedRun.status}
                </span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectedRun(null)}>✕ Close</button>
            </div>

            {runLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><div className="spinner" /></div>
            ) : (
              <div className="timeline">
                {selectedRun.zapRunSteps.map((step, idx) => {
                  const cfg = STATUS_CONFIG[step.status] ?? STATUS_CONFIG.processing;
                  const name = step.zapStep.availableAction?.name ?? step.zapStep.availableTrigger?.name ?? `Step ${idx + 1}`;
                  return (
                    <div key={step.id} className="timeline-item">
                      <div className={`timeline-dot ${cfg.dot}`}>{cfg.emoji}</div>
                      <div className="timeline-body">
                        <div className="timeline-header">
                          <span className="timeline-name">{name}</span>
                          <span className={`badge ${cfg.badge}`} style={{ fontSize: 10 }}>{step.status}</span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                          {fmt(step.executedAt)}
                        </div>
                        {step.output && (
                          <div className="code-block" style={{ maxHeight: 120, overflowY: 'auto', fontSize: 11 }}>
                            {JSON.stringify(step.output, null, 2)}
                          </div>
                        )}
                        {step.errorMessage && (
                          <div className="alert alert-error" style={{ fontSize: 12, marginTop: 8 }}>
                            <strong>{step.errorCode}</strong>: {step.errorMessage}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
