// NextAuth logger routing: browser-reported failures are info with fixed fields; server errors stay errors.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createModuleLoader } from './lib/memory-test-harness.mjs';
for (const key of Object.keys(process.env)) if (/^LOGTAIL_/.test(key)) delete process.env[key];
const forbidden = new Proxy({}, { get() { throw new Error('Database forbidden'); } });
const { root, load } = createModuleLoader({ prismaFor: () => forbidden });
const logger = load(join(root, 'src/lib/logger.ts'));
const { nextAuthLogger } = load(join(root, 'src/lib/authLogger.ts'));
const lines = [];
logger.setDiagnosticSink({ debug: () => {}, info: line => lines.push(['info', line]), error: line => lines.push(['error', line]) });
let passed = 0;
const check = (label, fn) => { lines.length = 0; fn(); passed++; console.log(`PASS ${label}`); };

check('a browser session fetch failure is an info line with a classified reason and endpoint', () => {
  // Shape posted by next-auth/react proxyLogger to /api/auth/_log (URLSearchParams, so client is a string).
  nextAuthLogger.error('CLIENT_FETCH_ERROR', { client: 'true', error: '[object Object]', message: 'Failed to fetch', url: '/api/auth/session' });
  assert.equal(lines.length, 1); assert.equal(lines[0][0], 'info');
  assert.match(lines[0][1], /^\[NextAuthClient\] CLIENT_FETCH_ERROR \{"reason":"network","path":"\/api\/auth\/session"\}$/);
});
check('an HTML page during a deploy is classified as non_json', () => {
  nextAuthLogger.error('CLIENT_FETCH_ERROR', { client: 'true', message: "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON", url: 'https://newvers.ai/api/auth/csrf' });
  assert.match(lines[0][1], /"reason":"non_json","path":"\/api\/auth\/csrf"/);
});
check('client-controlled text, codes and URLs never reach the log', () => {
  nextAuthLogger.error('<script>alert(1)</script>', { client: 'true', message: 'PRIVATE_SENTINEL user@example.com', url: 'https://evil.example/steal?token=PRIVATE_SENTINEL' });
  assert.equal(lines[0][0], 'info');
  assert.match(lines[0][1], /^\[NextAuthClient\] UNKNOWN \{"reason":"other","path":"unknown"\}$/);
  assert.doesNotMatch(lines[0][1], /PRIVATE_SENTINEL|evil|script|example\.com/);
});
check('server-side NextAuth errors keep their error-level report', () => {
  nextAuthLogger.error('JWT_SESSION_ERROR', new Error('decryption failed'));
  assert.equal(lines.length, 1); assert.equal(lines[0][0], 'error');
  assert.match(lines[0][1], /^\[Auth\] NextAuth\.JWT_SESSION_ERROR /);
});
console.log(`Auth logger: ${passed} checks passed`);
