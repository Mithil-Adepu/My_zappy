import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Allow env var injection without needing next.env
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
  },
};

export default nextConfig;
