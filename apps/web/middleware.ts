import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/signup'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Let public paths through always
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Root redirect handled client-side (localStorage access)
  if (pathname === '/') return NextResponse.next();

  // For dashboard routes: check cookie-based token (set by the login page)
  // Note: we can't read localStorage in middleware (server-side), so we use
  // a cookie mirror that the login page sets alongside localStorage.
  const token = request.cookies.get('zapier_token')?.value;
  if (!token && pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
