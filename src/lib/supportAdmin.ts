import { timingSafeEqual } from "node:crypto";

export function supportAdminAuthorized(request: Request): boolean {
  const secret = process.env['ADMIN_SECRET'];
  const supplied = request.headers.get('authorization');
  if (!secret || !supplied) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export function supportAdminOriginAllowed(request: Request): boolean {
  const origin = request.headers.get('origin');
  // Non-browser API clients still require the explicit Bearer credential.
  if (origin === null) return true;
  const source = parseHttpUrl(origin);
  if (!source || source.pathname !== '/' || source.search || source.hash) return false;
  // A proxy may expose an internal HTTP request URL even for the public HTTPS site.
  // Trust server configuration, never client-controlled Host / forwarded headers.
  const allowed = new Set(['https://newvers.ai']);
  for (const value of [process.env['NEXTAUTH_URL'], process.env['NEXT_PUBLIC_APP_URL']]) {
    if (!value) continue;
    const configured = parseHttpUrl(value);
    if (configured) allowed.add(configured.origin);
  }
  if (process.env['NODE_ENV'] !== 'production') {
    const target = parseHttpUrl(request.url);
    if (target && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) allowed.add(target.origin);
  }
  return allowed.has(source.origin);
}
