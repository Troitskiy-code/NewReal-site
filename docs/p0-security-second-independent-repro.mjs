// Follow-up review: synthetic data, actual handler sources, no production/network.
// Run with the same alias-register command as the first independent harness.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import util from 'node:util';

process.env.LOGTAIL_SOURCE_TOKEN = '';
process.env.LOGTAIL_INGESTING_HOST = '';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logger = await import('../src/lib/logger.ts');
const diagnostics = await import('../src/lib/safeDiagnostics.ts');
const SYN = 'SYNTHETIC_SECOND_REVIEW_PRIVATE_VALUE';
const originalConsole = { error: console.error, log: console.log, info: console.info };
let lines = [];
let sink = [];
const results = [];
console.error = (...args) => lines.push(util.format(...args));
console.info = (...args) => lines.push(util.format(...args));
console.log = (...args) => lines.push(util.format(...args));
logger.setDiagnosticSink({
  debug(message) { sink.push(message); },
  info(message) { sink.push(message); },
  error(message) { sink.push(message); },
});
function load(file, imports) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const module = { exports: {} };
  const mockRequire = (id) => {
    if (Object.hasOwn(imports, id)) return imports[id];
    throw new Error(`Unmocked import: ${id}`);
  };
  new Function('require', 'module', 'exports', 'console', 'process', 'fetch', compiled)(
    mockRequire, module, module.exports, console, { env: {} },
    () => { throw new Error('Network forbidden'); },
  );
  return module.exports;
}
async function check(label, run) {
  lines = [];
  sink = [];
  const extra = await run();
  results.push({ label, leakedToConsole: lines.some((line) => line.includes(SYN)),
    leakedToSink: sink.some((line) => line.includes(SYN)), ...extra });
}
const common = {
  'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
  '@/lib/apiI18n': { apiT: () => 'safe_public_error', getApiLocale: () => 'ru' },
  '@/lib/logger': logger,
  'bcryptjs': { hash: async () => 'SYNTHETIC_HASH' },
};
try {
  await check('safeDiagnostics correctly drops message-only object', () => {
    diagnostics.reportAuthFailure('Synthetic', { message: SYN });
  });
  await check('errorLog treats message-only error as context', () => {
    logger.errorLog('Auth', 'synthetic failure', { message: SYN });
  });
  await check('errorLog treats name+message error without stack as context', () => {
    logger.errorLog('Auth', 'synthetic failure', { name: 'Error', message: SYN });
  });
  await check('errorLog preserves nested non-Error thrown string', () => {
    logger.errorLog('Auth', 'synthetic failure', { userId: 'synthetic-user', error: SYN });
  });
  await check('register.POST actual catch with message-only thrown object', async () => {
    const handler = load('src/app/api/auth/register/route.ts', {
      ...common,
      '@/lib/prisma': { prisma: { user: { findUnique: async () => { throw { message: SYN }; } } } },
      '@/lib/ensureUserConsent': { isAcceptedFlag: () => true, ensureUserConsentColumns: async () => {} },
      '@/lib/provisionNewUser': { applySignupBenefits: async () => {} },
      '@/lib/emailVerification': { createAndSendVerificationEmail: async () => {} },
    });
    const response = await handler.POST({ json: async () => ({ email: 'review@example.test', password: 'synthetic' }) });
    return { status: response.status, responseSafe: !JSON.stringify(response).includes(SYN) };
  });
  await check('reset-password.GET actual catch with message-only thrown object', async () => {
    const handler = load('src/app/api/auth/reset-password/route.ts', {
      ...common,
      '@/lib/prisma': { prisma: { passwordResetToken: { findUnique: async () => { throw { message: SYN }; } } } },
    });
    const response = await handler.GET({ nextUrl: new URL('http://localhost/reset?token=synthetic') });
    return { status: response.status, responseSafe: !JSON.stringify(response).includes(SYN) };
  });
  await check('resend-verification actual inner catch with thrown string in context', async () => {
    const handler = load('src/app/api/auth/resend-verification/route.ts', {
      ...common,
      'next-auth/next': { getServerSession: async () => ({ user: { id: 'synthetic-user' } }) },
      '@/lib/auth': { authOptions: {} },
      '@/lib/prisma': { prisma: { user: { findUnique: async () => ({ id: 'synthetic-user', email: 'review@example.test' }) } } },
      '@/lib/emailVerification': { isEmailVerified: () => false,
        createAndSendVerificationEmail: async () => { throw SYN; } },
    });
    const response = await handler.POST({});
    return { status: response.status, responseSafe: !JSON.stringify(response).includes(SYN) };
  });
  await check('ordinary Error remains safe', () => {
    logger.errorLog('Auth', 'synthetic failure', new Error(SYN));
  });
} finally {
  Object.assign(console, originalConsole);
  logger.setDiagnosticSink(null);
}
const output = { productionUsed: false, realNetworkCalls: 0, results };
fs.writeFileSync(path.join(root, 'docs/p0-security-second-independent-repro.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
