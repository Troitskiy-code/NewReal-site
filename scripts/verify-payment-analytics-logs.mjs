// Isolated logging checks: no .env, database, provider, or live counter.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { NextRequest, NextResponse } from 'next/server.js';

function load(file, dependencies = {}) {
  const loadedModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

const browserLogs = [];
const originalInfo = console.info;
try {
  console.info = (...args) => browserLogs.push(args.join(' '));
  const { logPurchaseAnalytics } = load('src/lib/purchaseAnalyticsLog.ts');
  logPurchaseAnalytics('dispatch_started', { invoiceId: '123', orderId: 'po_synthetic123' },
    { goal: 'vc_purchase_success', attempts: 1 });
  assert.match(browserLogs[0], /dispatch_started/);
  assert.match(browserLogs[0], /po_synthetic123/);
  logPurchaseAnalytics('receipt_rejected', { invoiceId: 'email@private.test', orderId: 'Bearer PRIVATE_TOKEN' },
    { goal: 'PRIVATE_TOKEN', state: 'PRIVATE_TOKEN', status: 403, attempts: 99 });
  assert.ok(!browserLogs[1].includes('PRIVATE_TOKEN') && !browserLogs[1].includes('private.test'));
  assert.match(browserLogs[1], /"status":403/);
  assert.ok(!browserLogs[1].includes('attempts'));
  console.info = () => { throw Error('console unavailable'); };
  assert.doesNotThrow(() => logPurchaseAnalytics('counter_not_ready', { invoiceId: '123' }));
} finally { console.info = originalInfo; }

const logs = [];
let session = { user: { id: 'private-user' } };
let failure = null;
let committed = false;
let writes = 0;
const event = { id: 'syntheticevent', invoiceId: '123', userId: 'private-user', kind: 'purchase', amountRub: 300 };
const route = load('src/app/api/payment/analytics/route.ts', {
  'next/server': { NextResponse },
  'next-auth/next': { getServerSession: async () => session },
  '@/lib/auth': { authOptions: {} },
  '@/lib/prisma': { prisma: { $transaction: async fn => {
    committed = false;
    const response = await fn({
      paymentEvent: { findUnique: async () => event },
      paymentOrder: { findUnique: async () => null },
      $executeRaw: async () => { writes++; if (failure === 'write') throw Error('Bearer PRIVATE_TOKEN'); },
    });
    if (failure === 'commit') throw Error('Bearer PRIVATE_TOKEN');
    committed = true;
    return response;
  } } },
  '@/lib/paymentEvent': { PAYMENT_PROVIDER: 'robokassa' },
  '@/lib/paymentStatus': { normalizeInvId: value => /^\d{1,20}$/.test(String(value)) ? String(value) : null },
  '@/lib/paymentOrders': {
    isDeclaredTestPayment: () => false, paymentOrderMatchesEvent: () => false,
    publicPaymentOrderId: () => 'pe_syntheticevent',
  },
  '@/lib/metrika': { METRIKA_GOALS: { vcPurchaseSuccess: 'vc_purchase_success', subscriptionSuccess: 'subscription_success' }, subscriptionGoal: () => null },
  '@/lib/logger': { infoLog: (...args) => logs.push({ args, committed }), errorLog: (...args) => logs.push({ args, committed }) },
  '@/lib/safeDiagnostics': { toSafeDiagnostic: () => ({ category: 'error' }) },
  '@/lib/supportAdmin': { supportAdminOriginAllowed: req => req.headers.get('origin') === 'https://newvers.ai' },
});
const body = { invoiceId: '123', orderId: 'pe_syntheticevent', goal: 'vc_purchase_success', state: 'callback_completed', attempts: 1 };
const request = (value = body, origin = 'https://newvers.ai') => new NextRequest('https://newvers.ai/api/payment/analytics', {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(value),
});
assert.equal((await route.POST(request())).status, 200);
const accepted = logs.find(log => log.args[1] === 'receipt_saved');
assert.ok(accepted?.committed, 'Success diagnostic is emitted after transaction commit');
assert.equal(accepted.args[2].invoiceId, '123');
assert.equal(accepted.args[2].reportedState, 'callback_completed');
assert.equal(accepted.args[2].orderId, 'pe_syntheticevent');
for (const mode of ['write', 'commit']) {
  logs.length = 0; failure = mode;
  assert.equal((await route.POST(request())).status, 500);
  assert.ok(!logs.some(log => log.args[1] === 'receipt_saved'), 'Failed persistence must not be logged as saved');
  assert.ok(!JSON.stringify(logs).includes('PRIVATE_TOKEN'));
}
failure = null; logs.length = 0;
const before = writes;
assert.equal((await route.POST(request({ ...body, orderId: 'Bearer PRIVATE_TOKEN' }))).status, 400);
assert.equal(writes, before);
assert.ok(!JSON.stringify(logs).includes('PRIVATE_TOKEN'));
assert.equal((await route.POST(request(body, 'https://private.test/?token=PRIVATE_TOKEN'))).status, 403);
session = null;
assert.equal((await route.POST(request())).status, 401);
assert.ok(!JSON.stringify(logs).includes('PRIVATE_TOKEN') && !JSON.stringify(logs).includes('private.test'));
assert.ok(!JSON.stringify(logs).includes('private-user'));
console.log('PASS: browser privacy, failure isolation, receipt rejection and post-commit server diagnostics');
