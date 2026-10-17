// Offline handler checks and reproducible audit findings. Never loads .env or calls a provider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import ts from 'typescript';
import { NextRequest, NextResponse } from 'next/server.js';

const require = createRequire(import.meta.url);
const quietLogger = { debugLog() {}, infoLog() {}, errorLog() {}, toSafeDiagnostic: () => ({ category: 'error' }) };
function modules(overrides = {}) {
  const cache = new Map();
  function load(file) {
    file = resolve(file);
    if (cache.has(file)) return cache.get(file);
    const mod = { exports: {} }; cache.set(file, mod.exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      if (name in overrides) return overrides[name];
      if (name === 'next/server') return { NextRequest, NextResponse };
      if (name === '@/lib/logger' || name === './logger') return quietLogger;
      if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
      if (name.startsWith('.')) return load(resolve(dirname(file), `${name}.ts`));
      return require(name);
    }, mod, mod.exports);
    cache.set(file, mod.exports); return mod.exports;
  }
  return load;
}

process.env.ROBOKASSA_MERCHANT_ID = 'synthetic_shop';
process.env.ROBOKASSA_PASSWORD = 'synthetic_password1';
process.env.ROBOKASSA_PASSWORD2 = 'synthetic_password2';
process.env.ROBOKASSA_TEST_MODE = '0';
delete process.env.PAYMENT_TEST_USER_IDS;
const originalFetch = globalThis.fetch, originalLog = console.log;
globalThis.fetch = async () => { throw Error('External network forbidden'); };
console.log = () => {};
let checks = 0;
const pass = label => { checks++; originalLog(`PASS ${label}`); };
const request = (path, body = {}, raw = false) => new NextRequest(`https://newvers.ai${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://newvers.ai' },
  body: raw ? body : JSON.stringify(body),
});
const checkoutOptions = { userId: 'synthetic_user', sum: 300, desc: '1000 VC',
  extraShp: { Shp_type: 'vc', Shp_packageId: '1', Shp_vc: '1000' } };
try {
  const robokassa = modules()('src/lib/robokassa.ts');
  const originalNow = Date.now, originalRandom = Math.random;
  const ids = new Set();
  try {
    Date.now = () => 1_800_000_000_000; Math.random = () => 0;
    for (let i = 0; i < 10000; i++) {
      const id = robokassa.createRobokassaCheckout(checkoutOptions).fields.InvId;
      assert.ok(/^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= BigInt('9223372036854775807'));
      ids.add(id);
    }
  } finally { Date.now = originalNow; Math.random = originalRandom; }
  assert.equal(ids.size, 10000); pass('10000 distinct signed-64-bit invoice IDs with frozen time/random');

  const receipt = robokassa.buildReceipt([{ name: 'Пополнение VC', price: 300 }]);
  const checkout = robokassa.createRobokassaCheckout({ ...checkoutOptions, receipt,
    successUrl2: 'https://newvers.ai/ru/coins?payment=success&type=vc' });
  const f = Object.fromEntries(new URLSearchParams(checkout.fields));
  const shp = Object.entries(f).filter(([key]) => key.startsWith('Shp_')).sort(([a], [b]) => a < b ? -1 : 1);
  const suffix = shp.map(([k, v]) => `:${k}=${v}`).join('');
  const expected = crypto.createHash('md5').update([
    f.MerchantLogin, f.OutSum, f.InvId, f.Receipt, f.SuccessUrl2, f.SuccessUrl2Method, 'synthetic_password1',
  ].join(':') + suffix).digest('hex');
  assert.equal(f.SignatureValue, expected);
  assert.deepEqual(JSON.parse(decodeURIComponent(f.Receipt)), receipt);
  pass('POST encoding preserves receipt and provider signature including return URL');
  const resultSignature = crypto.createHash('md5').update(`${f.OutSum}:${f.InvId}:synthetic_password2${suffix}`).digest('hex');
  assert.ok(robokassa.verifyRobokassaResultSignature(f.OutSum, f.InvId, resultSignature, Object.fromEntries(shp)));
  assert.ok(!robokassa.verifyRobokassaResultSignature('1.00', f.InvId, resultSignature, Object.fromEntries(shp)));
  pass('signed callback accepted; altered amount rejected');

  for (const [flag, expectedTest] of [['0', false], ['1', true], ['true', true], [' TRUE ', true], ['', false]]) {
    process.env.ROBOKASSA_TEST_MODE = flag;
    const load = modules({ '@/lib/prisma': { prisma: {} } });
    const testCheckout = load('src/lib/robokassa.ts').createRobokassaCheckout(checkoutOptions);
    const registry = load('src/lib/paymentOrders.ts');
    assert.equal(testCheckout.fields.IsTest === '1', expectedTest);
    assert.equal(registry.isDeclaredTestPayment('synthetic_user'), expectedTest);
  }
  process.env.ROBOKASSA_TEST_MODE = '0';
  pass('checkout and analytics agree for every supported test-mode spelling');
  delete process.env.ROBOKASSA_PASSWORD2;
  const incomplete = modules()('src/lib/robokassa.ts');
  assert.throws(() => incomplete.createRobokassaCheckout(checkoutOptions), /not configured/);
  await assert.rejects(() => incomplete.chargeRobokassaRecurring({ previousInvoiceId: '123', sum: 300, desc: 'test' }), /not configured/);
  process.env.ROBOKASSA_PASSWORD2 = 'synthetic_password2';
  pass('checkout and recurring request fail closed when callback password is missing');

  let session = { user: { id: 'synthetic_user' } }, unverified = null, dbFailure = false, registered;
  const loadRoutes = modules({
    'next-auth/next': { getServerSession: async () => session }, '@/lib/auth': { authOptions: {} },
    '@/lib/emailVerification': { rejectUnverifiedEmail: async () => unverified },
    '@/lib/getRequestLocale': { getRequestLocale: async () => 'ru' },
    '@/lib/safeDiagnostics': { reportPaymentFailure() {} }, '@/lib/prisma': { prisma: {} },
    '@/lib/firstVcPurchase': { reserveFirstVcCheckout: async () => null },
    '@/lib/paymentOrders': { registerPaymentOrder: async input => {
      if (dbFailure) throw Error('synthetic DB unavailable'); registered = input;
    } },
  });
  const vc = loadRoutes('src/app/api/payment/create/route.ts');
  const sub = loadRoutes('src/app/api/subscription/create/route.ts');
  for (const [route, path] of [[vc, '/api/payment/create'], [sub, '/api/subscription/create']]) {
    session = null; assert.equal((await route.POST(request(path))).status, 401);
    session = { user: { id: 'synthetic_user' } };
    unverified = NextResponse.json({ error: 'verify email' }, { status: 403 });
    assert.equal((await route.POST(request(path))).status, 403); unverified = null;
    for (const body of ['{broken', 'null', '[]']) {
      assert.equal((await route.POST(request(path, body, true))).status, 400);
    }
  }
  pass('both handlers reject unauthenticated, unverified and malformed requests');
  assert.equal((await vc.POST(request('/api/payment/create', { packageId: 999 }))).status, 400);
  assert.equal((await vc.POST(request('/api/payment/create', { packageId: 7 }))).status, 409);
  const created = await vc.POST(request('/api/payment/create', { packageId: 1, sum: 1, vc: 999999, userId: 'forged' }));
  assert.equal(created.status, 200);
  const createdFields = (await created.json()).fields;
  assert.equal(createdFields.OutSum, '300.00'); assert.equal(createdFields.Shp_vc, '1000');
  assert.equal(createdFields.Shp_userId, 'synthetic_user'); assert.equal(registered.amountRub, 300);
  pass('VC price, coin grant and payment owner come from server, not client input');
  const subBody = { planId: 'dialog', period: 'year', applyMode: 'immediate', recurringConsent: true };
  assert.equal((await sub.POST(request('/api/subscription/create', { ...subBody, recurringConsent: false }))).status, 400);
  const subscription = await sub.POST(request('/api/subscription/create', { ...subBody, sum: 1 }));
  assert.equal(subscription.status, 200); assert.equal((await subscription.json()).fields.OutSum, '4990.00');
  pass('subscription requires consent and uses canonical yearly price');
  dbFailure = true;
  for (const [route, path, body] of [[vc, '/api/payment/create', { packageId: 1 }], [sub, '/api/subscription/create', subBody]]) {
    const response = await route.POST(request(path, body)); assert.equal(response.status, 500);
    assert.ok(!(await response.json()).fields);
  }
  pass('failed order persistence never returns a payable form');

  if (process.argv.includes('--audit')) {
    // These are confirmations of OPEN findings, deliberately separate from regression passes.
    const user = { id: 'synthetic_user', email: null, emailVerified: new Date(), subscriptionType: 'dialog',
      subscriptionEnd: new Date(Date.now() + 3600000), robokassaRecurringId: '123',
      pendingSubscriptionType: null, verseCoins: 0, permanentCoins: 0, isSubscribed: true };
    const events = new Map(), transactions = [];
    const db = {
      user: { findUnique: async () => user, update: async ({ data }) => Object.assign(user, data) },
      transaction: { findFirst: async () => null, create: async ({ data }) => { transactions.push(data); return data; } },
      paymentEvent: { findUnique: async ({ where }) => events.get(where.provider_invoiceId.invoiceId) ?? null,
        create: async ({ data }) => { events.set(data.invoiceId, data); return data; } },
      firstVcPurchase: { findUnique: async () => null }, notification: { create: async () => ({}) },
      $queryRaw: async () => [{ id: user.id }], $transaction: async fn => fn(db),
    };
    const auditLoad = modules({ '@/lib/prisma': { prisma: db } });
    globalThis.fetch = async () => new Response('ERROR: synthetic declined operation', { status: 200 });
    const before = user.subscriptionEnd.getTime();
    const renewed = await auditLoad('src/lib/subscriptionRenewal.ts').renewSubscriptionIfDue(user.id);
    assert.equal(renewed.renewed, true); assert.ok(user.subscriptionEnd.getTime() > before);
    originalLog('OPEN P1: HTTP 200 error body grants a renewal without payment confirmation');
    const webhook = auditLoad('src/app/api/payment/webhook/route.ts');
    const sign = payload => {
      const suffix = Object.entries(payload).filter(([k]) => k.startsWith('Shp_')).sort(([a], [b]) => a < b ? -1 : 1)
        .map(([k, v]) => `:${k}=${v}`).join('');
      return { ...payload, SignatureValue: crypto.createHash('md5')
        .update(`${payload.OutSum}:${payload.InvId}:synthetic_password2${suffix}`).digest('hex') };
    };
    const paid = { OutSum: '499.00', InvId: '456', Shp_userId: user.id, Shp_subscription: 'true',
      Shp_plan: 'dialog', Shp_period: 'month', Shp_applyMode: 'immediate' };
    user.robokassaRecurringId = null;
    events.set('456', { id: 'existing', userId: user.id, kind: 'subscription' });
    const replayed = await webhook.POST(request('/api/payment/webhook', { ...sign(paid), RecurringID: '987' }));
    assert.equal(replayed.status, 200); assert.equal(user.robokassaRecurringId, '987');
    originalLog('OPEN P1: replayed signed webhook restores cancelled recurring ID from unsigned RecurringID');
    const priorEnd = user.subscriptionEnd.getTime(), beforeTransactions = transactions.length;
    const child = sign({ ...paid, InvId: renewed.invId });
    assert.equal((await webhook.POST(request('/api/payment/webhook', child))).status, 200);
    assert.ok(user.subscriptionEnd.getTime() > priorEnd);
    assert.ok(transactions.length > beforeTransactions);
    originalLog('OPEN P1: recurring request and its callback grant the same renewal twice');
    const oldPackage = sign({ OutSum: '250.00', InvId: '789', Shp_userId: user.id,
      Shp_type: 'vc', Shp_packageId: '1', Shp_vc: '1000' });
    assert.equal((await webhook.POST(request('/api/payment/webhook', oldPackage))).status, 400);
    originalLog('OPEN P2: a correctly signed prior-price VC payment is rejected against the current catalog');
    let creditsGranted = 0;
    const billing = modules({
      '../stripe': { stripe: { webhooks: { constructEvent: () => ({ type: 'checkout.session.completed',
        data: { object: { id: 'cs_synthetic', payment_status: 'paid', metadata: { userId: user.id, credits: '100' } } } }) } } },
      '../config': { default: { stripe: { webhookSecret: 'synthetic' } }, __esModule: true },
      './user': { UserService: { addCredits: async (_id, amount) => { creditsGranted += amount; } } },
    })('src/lib/services/billing.js');
    await billing.BillingService.handleWebhook('synthetic', 'synthetic');
    await billing.BillingService.handleWebhook('synthetic', 'synthetic');
    assert.equal(creditsGranted, 200);
    originalLog('OPEN P2: duplicate Stripe callback grants credits twice (legacy route, no local Stripe credentials)');
  }
  originalLog(`Payment creation: ${checks} groups passed; no real database or provider used.`);
} finally { globalThis.fetch = originalFetch; console.log = originalLog; }
