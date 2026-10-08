// Independent P0 review. Only synthetic values, real source, mocked boundaries.
// Run: node --experimental-strip-types --import ./scripts/alias-register.mjs docs/p0-security-independent-repro.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import util from 'node:util';
import { spawnSync } from 'node:child_process';

process.env.LOGTAIL_SOURCE_TOKEN = '';
process.env.LOGTAIL_INGESTING_HOST = '';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const logger = await import('../src/lib/logger.ts');
const diagnostics = await import('../src/lib/safeDiagnostics.ts');
const redaction = await import('../src/lib/redactSensitive.ts');
const SYN = 'SYNTHETIC_REVIEW_CREDENTIAL_VALUE';
const results = [];
let captured = [];
let sinkCaptured = [];
const original = { error: console.error, info: console.info, log: console.log };
console.error = (...args) => captured.push(util.format(...args));
console.info = (...args) => captured.push(util.format(...args));
console.log = (...args) => captured.push(util.format(...args));
logger.setDiagnosticSink({
  error(message, context) { sinkCaptured.push({ message, context }); },
  info(message, context) { sinkCaptured.push({ message, context }); },
  debug(message, context) { sinkCaptured.push({ message, context }); },
});
const fakeError = () => Object.assign(new Error(`Prisma invocation args: token="${SYN}" password="${SYN}"`), {
  name: 'PrismaClientValidationError', clientVersion: '5.22.0',
});

function load(file, imports = {}, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const loadedModule = { exports: {} };
  const mockRequire = (id) => {
    if (Object.hasOwn(imports, id)) return imports[id];
    throw new Error(`Unmocked import ${id}`);
  };
  // Same-realm evaluation preserves instanceof Error and uses only allowlisted imports.
  new Function('require', 'module', 'exports', 'console', 'process', 'fetch', compiled)(
    mockRequire, loadedModule, loadedModule.exports, console,
    globals.process ?? { env: {} },
    globals.fetch ?? (() => { throw new Error('Network forbidden in review'); }),
  );
  return loadedModule.exports;
}
function check(label, work) {
  captured = [];
  sinkCaptured = [];
  return Promise.resolve().then(work).then((detail) => {
    results.push({ label, leakedToConsole: captured.some((line) => line.includes(SYN)),
      leakedToSink: JSON.stringify(sinkCaptured).includes(SYN), ...detail });
  });
}
const common = {
  'next/server': { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
  '@/lib/apiI18n': { apiT: () => 'safe_public_error', getApiLocale: () => 'ru' },
  'bcryptjs': { hash: async () => 'SYNTHETIC_HASH' },
  '@/lib/logger': logger,
};

try {
  await check('register.POST actual catch, synthetic Prisma error', async () => {
    const handler = load('src/app/api/auth/register/route.ts', {
      ...common,
      '@/lib/prisma': { prisma: { user: { findUnique: async () => { throw fakeError(); } } } },
      '@/lib/ensureUserConsent': { isAcceptedFlag: () => true, ensureUserConsentColumns: async () => {} },
      '@/lib/provisionNewUser': { applySignupBenefits: async () => {} },
      '@/lib/emailVerification': { createAndSendVerificationEmail: async () => {} },
    });
    const response = await handler.POST({ json: async () => ({ email: 'review@example.test', password: SYN }) });
    return { status: response.status, responseSafe: !JSON.stringify(response).includes(SYN) };
  });
  await check('reset-password.GET actual catch, synthetic Prisma error', async () => {
    const handler = load('src/app/api/auth/reset-password/route.ts', {
      ...common,
      '@/lib/prisma': { prisma: { passwordResetToken: { findUnique: async () => { throw fakeError(); } } } },
    });
    const response = await handler.GET({ nextUrl: new URL(`http://localhost/reset?token=${SYN}`) });
    return { status: response.status, responseSafe: !JSON.stringify(response).includes(SYN) };
  });
  await check('reportAuthFailure plain error envelope retains message/stack/meta', async () => {
    diagnostics.reportAuthFailure('NextAuth.synthetic', { message: SYN, stack: SYN, meta: { queryArgs: SYN } });
  });
  await check('reportPrismaFailure non-Error thrown string is retained', async () => {
    diagnostics.reportPrismaFailure('SyntheticThrownString', SYN);
  });
  await check('formatSafeLog JSON-stringified password', async () => {
    logger.errorLog('Review', JSON.stringify({ password: SYN }));
  });
  await check('Error.name syntactic identifier is not a semantic allowlist', async () => {
    const error = new Error('safe');
    error.name = SYN;
    logger.errorLog('Review', error);
  });
  await check('actual Robokassa recurring failure with mocked JSON response', async () => {
    const robokassa = load('src/lib/robokassa.ts', {
      crypto: require('node:crypto'), 'crc-32': require('crc-32'),
      '@/lib/logger': logger, '@/lib/i18nConfig': { withLocale: (_locale, url) => url },
    }, {
      process: { env: { ROBOKASSA_MERCHANT_ID: 'synthetic', ROBOKASSA_PASSWORD: 'synthetic', ROBOKASSA_TEST_MODE: '1' } },
      fetch: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ password: SYN }) }),
    });
    let rejected = false;
    try { await robokassa.chargeRobokassaRecurring({ previousInvoiceId: 'synthetic-id', sum: 1, desc: 'synthetic' }); }
    catch { rejected = true; }
    return { rejected, realNetworkCalls: 0 };
  });
  await check('original Bearer and mixed DSN cases remain fixed', async () => {
    logger.errorLog('Review', `Authorization: Bearer ${SYN}`, `postgresql://synthetic:synthetic@localhost/test token=${SYN}`);
  });
  const cycle = [];
  cycle.push(cycle);
  results.push({ label: 'cyclic array remains fixed', value: redaction.redactSensitive(cycle)[0] });
  const scanFixture = path.join(root, 'p0-security-review-scan-fixture.json');
  if (fs.existsSync(scanFixture)) throw new Error('Refusing to overwrite scan fixture');
  try {
    fs.writeFileSync(scanFixture, JSON.stringify({ syntheticOnly: true,
      apiKey: ['sk', 'live', 'SYNTHETIC_REVIEW_ONLY'].join('_') }), { flag: 'wx' });
    const inventory = spawnSync('git', ['ls-files', '-o', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
    const scan = spawnSync(process.execPath, ['--experimental-strip-types', '--import',
      './scripts/alias-register.mjs', 'scripts/verify-p0-security.ts'], { cwd: root, encoding: 'utf8',
      env: { ...process.env, LOGTAIL_SOURCE_TOKEN: '', LOGTAIL_INGESTING_HOST: '' } });
    results.push({ label: 'candidate root JSON with synthetic live-key-shaped marker is missed',
      candidateIncluded: inventory.stdout.includes(path.basename(scanFixture)),
      scannerExit: scan.status, scannerClaimedPassed: scan.stdout.includes('Passed 61 checks') });
  } finally {
    fs.unlinkSync(scanFixture);
  }
} finally {
  Object.assign(console, original);
  logger.setDiagnosticSink(null);
}
const output = { productionUsed: false, realNetworkCalls: 0, results };
const dest = path.join(root, 'docs/p0-security-independent-repro.json');
fs.writeFileSync(dest, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
