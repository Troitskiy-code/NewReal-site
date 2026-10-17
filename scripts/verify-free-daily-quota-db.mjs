// Free daily quota: reserveChatCharge on real Postgres (parallel last free reply, refunds, day change).
// Runtime: npm install --prefix <temporary-directory> embedded-postgres
// Run: GUEST_TEST_RUNTIME=<temporary-directory> npm run verify:quota:db
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const require = createRequire(resolve('package.json'));
const ts = require('typescript');
const { PrismaClient } = require('@prisma/client');
const EmbeddedPostgres = require(join(resolve(process.env.GUEST_TEST_RUNTIME), 'node_modules/embedded-postgres/dist/index.js')).default;

const port = await new Promise((ok, fail) => { const s = createServer(); s.on('error', fail); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const directory = mkdtempSync(join(tmpdir(), 'nv-quota-'));
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_quota_test', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog() {} });
const url = `postgresql://postgres:synthetic_quota_test@127.0.0.1:${port}/nv_quota_test`;
const db = new PrismaClient({ datasourceUrl: url, log: [] });

const noop = () => {};
const mocks = {
  '@/lib/aiCostTelemetry': { aiCostDiagnosticContext: () => ({}), meteredPost: noop, meteredChatFetch: noop },
  '@/lib/logger': { debugLog: noop, infoLog: noop, errorLog: (...a) => console.error('errorLog', ...a), toSafeDiagnostic: (e) => String(e) },
};
const cache = new Map();
function load(file) {
  file = resolve(file);
  if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} }; cache.set(file, mod.exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const dep = (name) => {
    if (name === '@/lib/prisma') return { prisma: db };
    if (name in mocks) return mocks[name];
    if (name.startsWith('@/')) { const b = join('src', name.slice(2)); return load(existsSync(b + '.ts') ? b + '.ts' : existsSync(b + '.tsx') ? b + '.tsx' : b + '.js'); }
    if (name.startsWith('.')) {
      const t = resolve(dirname(file), name);
      if (t === resolve('src/lib/prisma')) return { prisma: db };
      if (t.endsWith('.json')) return require(t);
      return load(existsSync(t + '.ts') ? t + '.ts' : existsSync(t) ? t : t + '.js');
    }
    return require(name);
  };
  new Function('require', 'module', 'exports', code)(dep, mod, mod.exports);
  cache.set(file, mod.exports); return mod.exports;
}

let checks = 0;
const check = (v, label) => { assert.ok(v, label); checks++; console.log(`PASS ${label}`); };

try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('nv_quota_test');
  const schema = join(directory, 'schema.prisma');
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace(/Unsupported\("vector\(\d+\)"\)/g, 'Bytes'));
  const push = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', schema], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 120000 });
  if (push.status !== 0) throw new Error(`schema push failed: ${push.stdout}\n${push.stderr}`);

  const { reserveChatCharge } = load('src/lib/chatHelpers.ts');
  const user = (data) => db.user.create({ data: { email: `${Math.random().toString(36).slice(2)}@synthetic.test`, ...data } });
  const reserve = (userId, extra = {}) => reserveChatCharge({ userId, costVC: 4, freeQuotaEligible: true, characterName: 'Test', modelDisplayName: 'Base', ...extra });
  const txCount = (userId, type) => db.transaction.count({ where: { userId, type } });

  // 1. 25 parallel requests, 8 VC: exactly 20 free, 2 paid, 3 refused.
  const u1 = await user({ verseCoins: 8, dailyRequests: 0 });
  const results = await Promise.all(Array.from({ length: 25 }, () => reserve(u1.id)));
  const free = results.filter(r => r.ok && r.chargedVC === 0).length;
  const paid = results.filter(r => r.ok && r.chargedVC === 4).length;
  const refused = results.filter(r => !r.ok).length;
  const after1 = await db.user.findUnique({ where: { id: u1.id } });
  check(free === 20 && paid === 2 && refused === 3, `parallel: 20 free, 2 paid, 3 refused (got ${free}/${paid}/${refused})`);
  check(after1.dailyRequests === 20 && after1.verseCoins === 0, 'counter 20, balance 0');
  check(await txCount(u1.id, 'chat_free') === 20 && await txCount(u1.id, 'chat') === 2, '20 chat_free and 2 chat transactions');
  const lastRefused = results.find(r => !r.ok);
  check(lastRefused.freeQuota?.remaining === 0 && lastRefused.balance === 0, 'refusal carries the used-up quota');

  // 2. Refund of a free reply gives the quota back.
  const u2 = await user({ verseCoins: 0 });
  const r2 = await reserve(u2.id);
  check(r2.ok && r2.chargedVC === 0 && r2.freeQuota.used === 1 && r2.freeQuota.remaining === 19, 'first free reply: 1 used, 19 left');
  await r2.refund(); await r2.refund();
  const after2 = await db.user.findUnique({ where: { id: u2.id } });
  check(after2.dailyRequests === 0 && await txCount(u2.id, 'chat_free') === 0, 'refund (twice) restores the counter once and deletes the ledger row');

  // 3. Refund after Moscow midnight does not decrement the new day's counter.
  const u3 = await user({ verseCoins: 0 });
  const r3 = await reserve(u3.id);
  await db.user.update({ where: { id: u3.id }, data: { dailyRequests: 3, dailyRequestsDate: new Date(Date.now() + 86400000) } });
  await r3.refund();
  const after3 = await db.user.findUnique({ where: { id: u3.id } });
  check(after3.dailyRequests === 3 && await txCount(u3.id, 'chat_free') === 0, 'refund after the day changed leaves the new counter alone');

  // 4. Not eligible (another model): VC are charged and the counter is untouched.
  const u4 = await user({ verseCoins: 20 });
  const r4 = await reserve(u4.id, { costVC: 15, freeQuotaEligible: false });
  const after4 = await db.user.findUnique({ where: { id: u4.id } });
  check(r4.ok && r4.chargedVC === 15 && r4.freeQuota === null && after4.verseCoins === 5 && after4.dailyRequests === 0, 'paid model: 15 VC charged, quota untouched');
  await r4.refund();
  check((await db.user.findUnique({ where: { id: u4.id } })).verseCoins === 20, 'paid refund still returns VC');

  // 5. Second week: limit 5.
  const u5 = await user({ verseCoins: 4, createdAt: new Date(Date.now() - 10 * 86400000), dailyRequests: 5, dailyRequestsDate: new Date() });
  const r5 = await reserve(u5.id);
  check(r5.ok && r5.chargedVC === 4 && r5.freeQuota.limit === 5 && r5.freeQuota.remaining === 0, 'second week, 5 of 5 used: paid at model price');

  // 6. Yesterday's counter does not count today.
  const u6 = await user({ verseCoins: 0, dailyRequests: 20, dailyRequestsDate: new Date(Date.now() - 86400000) });
  const r6 = await reserve(u6.id);
  const after6 = await db.user.findUnique({ where: { id: u6.id } });
  check(r6.ok && r6.chargedVC === 0 && after6.dailyRequests === 1, 'new Moscow day: counter restarts at 1');

  // 7. An active plan raises the limit: Dialog gives 30 a day after the first week.
  const u7 = await user({ verseCoins: 10, createdAt: new Date(Date.now() - 10 * 86400000), dailyRequests: 29, dailyRequestsDate: new Date(),
    subscriptionType: 'dialog', subscriptionEnd: new Date(Date.now() + 20 * 86400000) });
  const r7a = await reserve(u7.id);
  const r7b = await reserve(u7.id);
  check(r7a.ok && r7a.chargedVC === 0 && r7a.freeQuota.limit === 30 && r7a.freeQuota.remaining === 0, 'Dialog: 30th reply of the day is free');
  check(r7b.ok && r7b.chargedVC === 4, 'Dialog: 31st reply is paid at model price');

  // 8. An expired plan falls back to 5.
  const u8 = await user({ verseCoins: 10, createdAt: new Date(Date.now() - 10 * 86400000), dailyRequests: 5, dailyRequestsDate: new Date(),
    subscriptionType: 'universe', subscriptionEnd: new Date(Date.now() - 86400000) });
  const r8 = await reserve(u8.id);
  check(r8.ok && r8.chargedVC === 4 && r8.freeQuota.limit === 5, 'expired plan: back to 5 a day');

  console.log(`\nQuota DB verification: ${checks} passed`);
} finally {
  await db.$disconnect().catch(() => {});
  await pg.stop().catch(() => {});
}
