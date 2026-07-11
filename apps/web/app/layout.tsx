import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ZapFlow — Workflow Automation',
  description: 'Connect your apps and automate workflows — no code required.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
