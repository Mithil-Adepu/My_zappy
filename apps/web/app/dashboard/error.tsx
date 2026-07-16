'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[ZapFlow] Dashboard error:', error);
  }, [error]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
      gap: 16,
      textAlign: 'center',
      padding: 40,
    }}>
      <div style={{ fontSize: 40 }}>⚠️</div>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
        Something went wrong
      </h2>
      <p style={{ color: 'var(--text-secondary)', maxWidth: 400, fontSize: 14 }}>
        {error.message ?? 'An unexpected error occurred in the dashboard.'}
      </p>
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn btn-primary" onClick={reset}>Try again</button>
        <Link href="/dashboard/zaps">
          <button className="btn btn-secondary">Go to My Zaps</button>
        </Link>
      </div>
    </div>
  );
}
