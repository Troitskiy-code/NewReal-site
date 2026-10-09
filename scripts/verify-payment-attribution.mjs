// Isolated fake browser + private PostgreSQL. No .env, live provider or live counter.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { NextRequest } from 'next/server.js';
import { Client } from 'pg';
import { startHarness } from './lib/memory-test-harness.mjs';
import { buildPaymentAttributionReport } from './lib/payment-attribution-report.mjs';
const require = createRequire(import.meta.url);
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`PASS ${label}`); };
const cache = new Map(); let ready = false, clientCallback;
function load(file) {
  file = resolve(file); if (cache.has(file)) return cache.get(file);
  const loadedModule = { exports: {} }; cache.set(file, loadedModule.exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require','module','exports',code)(name => {
    if (name === './metrika') return { METRIKA_COUNTER_ID: '999001' };
    if (name === './metrikaLoader') return { isMetrikaCounterReady: () => ready };
    if (name.startsWith('.')) return load(resolve(dirname(file), name + '.ts'));
    return require(name);
  }, loadedModule, loadedModule.exports); return loadedModule.exports;
}
const policy = load('src/lib/paymentAttribution.ts'), now = Date.now();
const landing = 'https://newvers.ai/ru?utm_source=yandex&utm_campaign=714376678&yclid=123456789&email=private%40example.test&token=PRIVATE#PRIVATE';
const touch = policy.visitTouchFromUrl(landing, 'https://yandex.ru/search?q=PRIVATE', now);
check(touch.utm_source === 'yandex' && touch.yclid === '123456789' && touch.referrerHost === 'yandex.ru', 'campaign and referrer hostname captured');
check(!JSON.stringify(touch).includes('PRIVATE') && !JSON.stringify(touch).includes('email'), 'URL/path/hash/token/email excluded');
check(policy.visitTouchFromUrl('https://newvers.ai/ru/coins?InvId=2&utm_source=robokassa', '', now) === null, 'payment return cannot overwrite source');
check(policy.visitTouchFromUrl('https://newvers.ai/ru/reset-password/private', '', now) === null, 'token page ignored');
let attribution = policy.updateVisitAttribution(null, touch, now);
attribution = policy.updateVisitAttribution(attribution, { at: now + 1 }, now + 1);
check(attribution.lastNonDirect.utm_source === 'yandex', 'direct navigation preserves last non-direct');
attribution = policy.updateVisitAttribution(attribution, { at: now + 2, utm_source: 'second' }, now + 2);
check(attribution.firstTouch.utm_source === 'yandex' && attribution.lastNonDirect.utm_source === 'second', 'first touch immutable, latest campaign replaced');
check(policy.normalizeCheckoutAttribution(attribution, now + policy.ATTRIBUTION_TTL_MS + 3) === null, 'expired attribution dropped');
const cleaned = policy.normalizeCheckoutAttribution({ ...attribution, email: 'private@example.test', clientId: '12345678', counterId: '999001',
  firstTouch: { ...touch, utm_term: 'private@example.test', referrerHost: 'https://secret/path', token: 'PRIVATE' } }, now);
check(cleaned.clientId === '12345678' && !JSON.stringify(cleaned).includes('secret') && !JSON.stringify(cleaned).includes('private@'), 'server strips unknown fields and invalid labels/hosts');
const storage = new Map(); let blocked = false;
globalThis.document = { referrer: 'https://yandex.ru/' };
globalThis.window = { location: { href: landing }, setTimeout, clearTimeout,
  sessionStorage: { getItem: k => { if (blocked) throw Error('blocked'); return storage.get(k) ?? null; },
    setItem: (k,v) => { if (blocked) throw Error('blocked'); storage.set(k,v); }, removeItem: k => storage.delete(k) },
  ym: (_id,_method,cb) => { clientCallback = cb; } };
const browser = load('src/lib/checkoutAttributionClient.ts');
browser.setAttributionUser(null); browser.captureVisitAttribution(); browser.setAttributionUser('A');
check((await browser.getCheckoutAttribution()).firstTouch.utm_source === 'yandex', 'guest source survives login');
ready = true;
let pending = browser.getCheckoutAttribution(); clientCallback('1234567890');
check((await pending).clientId === '1234567890', 'initialized SDK client ID attached');
pending = browser.getCheckoutAttribution(); browser.setAttributionUser('B'); clientCallback('1111111111');
check(await pending === null, 'late SDK callback fenced across account switch');
ready = false;
check(await browser.getCheckoutAttribution() === null, 'account switch cannot recapture the prior account landing URL');
window.location.href = 'https://newvers.ai/ru/coins'; document.referrer = ''; blocked = true;
check(!(await browser.getCheckoutAttribution()).lastNonDirect, 'another account does not inherit prior campaign even without storage');
window.location.href = landing; browser.captureVisitAttribution();
check((await browser.getCheckoutAttribution()).firstTouch.at, 'in-memory capture survives storage failure');
ready = true;
const started = Date.now(); await browser.getCheckoutAttribution();
check(Date.now() - started < 1500, 'SDK callback timeout does not block checkout indefinitely');
delete globalThis.window; delete globalThis.document;

process.env['ROBOKASSA_MERCHANT_ID'] = 'synthetic_data01';
process.env['ROBOKASSA_PASSWORD'] = 'synthetic_data01_pwd1';
process.env['ROBOKASSA_PASSWORD2'] = 'synthetic_data01_pwd2';
process.env['ROBOKASSA_TEST_MODE'] = '0'; process.env['NEXT_PUBLIC_YANDEX_METRIKA_ID'] = '999001';
delete process.env['PAYMENT_TEST_USER_IDS']; delete process.env['EMAIL_VERIFICATION_CUTOFF_DATE'];
const h = await startHarness({ label: 'data01', sourceTransform: (file, source) => file.endsWith('getRequestLocale.ts')
  ? 'export async function getRequestLocale() { return "ru"; }' : source });
try {
  // Test defaults match the application's UTC timestamp convention on every pool connection.
  await h.db.$executeRawUnsafe("ALTER DATABASE nv_memory_test SET timezone = 'UTC'");
  await h.db.$disconnect();
  const a = await h.db.user.create({ data: { email: 'data01-a@example.test', emailVerified: new Date() } });
  const b = await h.db.user.create({ data: { email: 'data01-b@example.test', emailVerified: new Date() } });
  h.session.userId = a.id;
  // Upgrade the old schema using the exact production SQL; preserve a historical event.
  const historical = await h.db.paymentEvent.create({ data: { provider: 'robokassa', invoiceId: '123', userId: a.id, kind: 'purchase', amountRub: 300 } });
  const sql = new Client({ connectionString: h.databaseUrl }); await sql.connect();
  try {
    await sql.query('DROP TABLE "PaymentGoalReceipt"; DROP TABLE "PaymentOrder"');
    await sql.query(readFileSync('prisma/migrations/20261009120000_payment_attribution/migration.sql', 'utf8'));
    check(await h.db.paymentEvent.count() === 1, 'exact migration upgrades old schema without changing historical revenue');
  } finally { await sql.end(); }
  const request = (path, body, origin = 'https://newvers.ai') => new NextRequest(`https://newvers.ai${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
  const create = h.load('src/app/api/payment/create/route.ts');
  const subs = h.load('src/app/api/subscription/create/route.ts');
  const status = h.load('src/app/api/payment/status/route.ts');
  const receipt = h.load('src/app/api/payment/analytics/route.ts');
  const webhook = h.load('src/app/api/payment/webhook/route.ts');
  const pkg = h.load('src/lib/vcPackages.ts').VC_PACKAGES.find(p => p.id !== 0);
  const plan = h.load('src/lib/chatEconomy.ts').SUBSCRIPTION_PLANS.find(p => p.monthlyPrice > 0);
  const checkoutResponse = await create.POST(request('/api/payment/create', { packageId: pkg.id, attribution: cleaned, isTest: true, amount: 1 }));
  check(checkoutResponse.status === 200, 'real VC checkout handler registers order');
  const checkout = await checkoutResponse.json(), inv = checkout.fields.InvId;
  const order = await h.db.paymentOrder.findUnique({ where: { provider_invoiceId: { provider: 'robokassa', invoiceId: inv } } });
  check(order?.amountRub === pkg.price && order?.attribution.clientId === '12345678' && !order.isTest, 'server catalog amount, owner and test flag cannot be forged');
  const registry = h.load('src/lib/paymentOrders.ts');
  await registry.registerPaymentOrder({ invoiceId: inv, userId: a.id, kind: 'purchase', amountRub: pkg.price, packageId: pkg.id, reuseInvoice: true,
    attribution: { ...cleaned, firstTouch: { at: Date.now(), utm_source: 'overwrite' } } });
  check((await h.db.paymentOrder.findUnique({ where: { id: order.id } })).attribution.firstTouch.utm_source === 'yandex', 'invoice retry preserves initial attribution');
  await assert.rejects(() => registry.registerPaymentOrder({ invoiceId: inv, userId: a.id, kind: 'purchase', amountRub: pkg.price, packageId: pkg.id }));
  check(true, 'ordinary checkout collision rejected instead of silently reusing an invoice');
  await assert.rejects(() => registry.registerPaymentOrder({ invoiceId: inv, userId: b.id, kind: 'purchase', amountRub: pkg.price, packageId: pkg.id, reuseInvoice: true }));
  check(true, 'invoice owner conflict rejected');
  let visible = await (await status.GET(new NextRequest(`https://newvers.ai/api/payment/status?invId=${inv}`))).json();
  check(visible.status === 'pending' && !visible.orderId, 'checkout alone cannot confirm payment or expose order');
  const shp = Object.fromEntries(Object.entries(checkout.fields).filter(([key]) => key.startsWith('Shp_')));
  const outSum = checkout.fields.OutSum;
  const signature = createHash('md5').update(`${outSum}:${inv}:synthetic_data01_pwd2:` + Object.entries(shp).sort(([x],[y]) => x.localeCompare(y)).map(([k,v]) => `${k}=${v}`).join(':')).digest('hex');
  const paid = { OutSum: outSum, InvId: inv, SignatureValue: signature, ...shp };
  const hookResponses = await Promise.all([webhook.POST(request('/api/payment/webhook', paid)), webhook.POST(request('/api/payment/webhook', paid))]);
  check(hookResponses.every(r => r.status === 200) && await h.db.paymentEvent.count({ where: { invoiceId: inv } }) === 1, 'parallel signed webhooks preserve one payment event');
  visible = await (await status.GET(new NextRequest(`https://newvers.ai/api/payment/status?invId=${inv}`))).json();
  check(visible.status === 'confirmed' && visible.orderId === `po_${order.id}` && visible.amountRub === pkg.price, 'confirmed owner status carries opaque order ID');
  const event = await h.db.paymentEvent.findFirst({ where: { invoiceId: inv } });
  h.session.userId = b.id;
  check(!(await (await status.GET(new NextRequest(`https://newvers.ai/api/payment/status?invId=${inv}`))).json()).orderId, 'foreign account cannot see order metadata');
  const body = { invoiceId: inv, orderId: visible.orderId, goal: 'vc_purchase_success', state: 'callback_completed', attempts: 1 };
  check((await receipt.POST(request('/api/payment/analytics', body))).status === 404, 'foreign receipt denied');
  h.session.userId = a.id;
  check((await receipt.POST(request('/api/payment/analytics', body, 'https://evil.test'))).status === 403, 'cross-origin receipt denied');
  check((await receipt.POST(request('/api/payment/analytics', { ...body, goal: 'subscription_success' }))).status === 400, 'goal type validated against confirmed event');
  check((await receipt.POST(request('/api/payment/analytics', { ...body, orderId: 'forged' }))).status === 400, 'opaque order identity validated');
  check((await receipt.POST(request('/api/payment/analytics', { ...body, state: 'attempt_started' }))).status === 200, 'pre-dispatch attempt is separate from a completed callback');
  check((await receipt.POST(request('/api/payment/analytics', null))).status === 400, 'null receipt body safely rejected');
  await h.db.paymentEvent.update({ where: { id: historical.id }, data: { kind: 'subscription' } });
  check((await receipt.POST(request('/api/payment/analytics', { ...body, invoiceId: '123',
    orderId: `pe_${historical.id}`, goal: null }))).status === 400, 'legacy subscription without a plan rejects null goal before SQL');
  await h.db.paymentEvent.update({ where: { id: historical.id }, data: { kind: 'purchase' } });
  await Promise.all([receipt.POST(request('/api/payment/analytics', body)), receipt.POST(request('/api/payment/analytics', { ...body, state: 'timeout', attempts: 3 }))]);
  const saved = await h.db.paymentGoalReceipt.findUnique({ where: { eventId_goal: { eventId: event.id, goal: body.goal } } });
  check(saved.state === 'callback_completed' && saved.attempts === 3 && await h.db.paymentGoalReceipt.count() === 1, 'parallel receipts merge monotonically without replacing callback');
  check(await h.db.transaction.count({ where: { userId: a.id, type: 'purchase' } }) === 1, 'analytics writes never grant or duplicate VC');
  const subscription = await subs.POST(request('/api/subscription/create', { planId: plan.id, period: 'month', applyMode: 'immediate', recurringConsent: true, attribution: cleaned }));
  check(subscription.status === 200 && await h.db.paymentOrder.count({ where: { kind: 'subscription', planId: plan.id } }) === 1, 'real subscription checkout records attribution');
  process.env['PAYMENT_TEST_USER_IDS'] = a.id;
  visible = await (await status.GET(new NextRequest(`https://newvers.ai/api/payment/status?invId=${inv}`))).json();
  check(visible.analyticsExcluded === true && (await receipt.POST(request('/api/payment/analytics', body))).status === 400, 'server-declared owner tests excluded from goals');
  delete process.env['PAYMENT_TEST_USER_IDS'];
  await h.db.paymentOrder.update({ where: { id: order.id }, data: { userId: b.id, isTest: true } });
  const mismatched = await (await status.GET(new NextRequest(`https://newvers.ai/api/payment/status?invId=${inv}`))).json();
  check(mismatched.orderId === `pe_${event.id}` && mismatched.analyticsExcluded === false, 'mismatched checkout owner cannot attach another account campaign or test flag');
  check((await receipt.POST(request('/api/payment/analytics', body))).status === 400, 'mismatched checkout identity rejected for receipt');
  await h.db.paymentOrder.update({ where: { id: order.id }, data: { userId: a.id, isTest: false } });
  await h.db.paymentOrder.update({ where: { id: order.id }, data: { planId: 'wrong-plan' } });
  check((await (await status.GET(new NextRequest(`https://newvers.ai/api/payment/status?invId=${inv}`))).json()).orderId === `pe_${event.id}`, 'product mismatch falls back to confirmed event without a guessed source');
  await h.db.paymentOrder.update({ where: { id: order.id }, data: { planId: null } });
  const legacy = await (await status.GET(new NextRequest('https://newvers.ai/api/payment/status?invId=123'))).json();
  check(legacy.orderId === `pe_${historical.id}` && await h.db.paymentOrder.count() === 2, 'legacy payment has stable ID without inventing historical attribution');
  h.session.userId = b.id;
  const firstPkg = h.load('src/lib/vcPackages.ts').FIRST_VC_PACKAGE;
  const firstResponses = await Promise.all([create.POST(request('/api/payment/create', { packageId: firstPkg.id, attribution: cleaned })),
    create.POST(request('/api/payment/create', { packageId: firstPkg.id, attribution: cleaned }))]);
  check(firstResponses.every(r => r.status === 200), 'parallel first-pack reservations register attribution in the same transaction');
  const firstCheckout = await firstResponses[0].json(), nextCheckout = await firstResponses[1].json();
  check(firstCheckout.fields.InvId === nextCheckout.fields.InvId && await h.db.paymentOrder.count({ where: { userId: b.id } }) === 1, 'first-pack retry keeps one invoice and order');
  const reported = spawnSync(process.execPath, ['scripts/report-payment-attribution.mjs'], { encoding: 'utf8', timeout: 45000,
    env: { ...process.env, PAYMENT_REPORT_DATABASE_URL: h.databaseUrl,
      PAYMENT_REPORT_FROM: new Date(Date.now() - 3600000).toISOString(), PAYMENT_REPORT_TO: new Date(Date.now() + 3600000).toISOString(),
      PAYMENT_TEST_USER_IDS: a.id, PAYMENT_REFUNDS_FILE: '' } });
  if (reported.status !== 0) throw new Error(reported.stderr || reported.stdout);
  const reportOutput = JSON.parse(reported.stdout), diskReport = JSON.parse(readFileSync(reportOutput.output, 'utf8'));
  assert.equal(reportOutput.tests.count, 2, JSON.stringify(reportOutput));
  check(diskReport.orders.length === 2, 'actual report queries confirmed events in a read-only UTC transaction');
  check(diskReport.orders.find(o => o.invoiceId === inv)?.confirmedAtUtc === event.createdAt.toISOString(), 'UTC dates round-trip without the operating-system timezone offset');
  check(!JSON.stringify(diskReport).includes(a.id) && !JSON.stringify(diskReport).includes('12345678'), 'actual report excludes user ID, client ID and click ID');
  const c = await h.db.user.create({ data: { email: 'data01-c@example.test', emailVerified: new Date() } });
  h.session.userId = c.id;
  await h.db.$executeRawUnsafe('ALTER TABLE "PaymentOrder" RENAME TO "PaymentOrder_test_hidden"');
  try {
    const unavailable = await create.POST(request('/api/payment/create', { packageId: firstPkg.id, attribution: cleaned }));
    check(unavailable.status === 500 && await h.db.firstVcPurchase.count({ where: { userId: c.id } }) === 0, 'missing migration prevents checkout and rolls back first reservation');
  } finally { await h.db.$executeRawUnsafe('ALTER TABLE "PaymentOrder_test_hidden" RENAME TO "PaymentOrder"'); }
  h.session.userId = a.id;
  const rows = [
    { eventId: event.id, orderId: order.id, createdAt: event.createdAt, kind: 'purchase', amountRub: pkg.price, cohort: 'repeat', isTest: false, attribution: order.attribution, receipts: [saved] },
    { eventId: historical.id, createdAt: historical.createdAt, kind: 'purchase', amountRub: 300, cohort: 'first', isTest: true, receipts: [] },
    { eventId: 'renewal000', createdAt: new Date(), kind: 'subscription_renewal', amountRub: 499, cohort: 'renewal', isTest: false, receipts: [] },
  ];
  const report = buildPaymentAttributionReport(rows, { from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' });
  check(report.summary.real.grossRub === pkg.price + 499 && report.summary.tests.count === 1 && report.summary.renewals.count === 1, 'confirmed revenue separated from tests/renewals');
  check(report.summary.real.clientCallbacks === 1 && report.summary.real.refundsRub === null && !JSON.stringify(report).includes('12345678'), 'missing/refund uncertainty explicit and client identifiers excluded from report');
  const refunded = buildPaymentAttributionReport(rows, { from: 'x', to: 'y', refunds: [{ id: 'refund1', orderId: `po_${order.id}`, amountRub: 10, refundedAt: new Date(Date.now() + 1000).toISOString() }] });
  check(refunded.summary.real.refundsRub === 10, 'explicit operator-supplied refund ledger accounted separately');
  assert.throws(() => buildPaymentAttributionReport(rows, { from: 'x', to: 'y', refunds: [{ id: 'bad', orderId: `po_${order.id}`, amountRub: pkg.price + 1, refundedAt: new Date(Date.now() + 1000).toISOString() }] }));
  check(true, 'over-refund rejected');
  console.log(`DATA-01: ${checks} passed`);
} finally { await h.stop(); }
