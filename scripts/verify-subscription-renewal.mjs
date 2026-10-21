// Real renewal cron and real Robokassa webhook on disposable PostgreSQL. No network, no .env.
// Regression for 2026-10-21: an automatic renewal was applied by the cron AND by the webhook (+60 days, double VC).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startHarness } from './lib/memory-test-harness.mjs';
const require = createRequire(import.meta.url);
Object.assign(process.env, { ROBOKASSA_MERCHANT_ID: 'synthetic_merchant', ROBOKASSA_PASSWORD: 'synthetic_checkout_password',
  ROBOKASSA_PASSWORD2: 'synthetic_result_password', ROBOKASSA_TEST_MODE: 'false' });
const h = await startHarness({ label: 'subscription-renewal' });
const { db, load, root } = h;
const { NextRequest } = require('next/server');
const renewal = load(join(root, 'src/lib/subscriptionRenewal.ts'));
const webhook = load(join(root, 'src/app/api/payment/webhook/route.ts'));
const { getSubscriptionPlan } = load(join(root, 'src/lib/chatEconomy.ts'));
const charges = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://auth.robokassa.ru/Merchant/Recurring') throw new Error(`External network forbidden: ${url}`);
  charges.push(Object.fromEntries(new URLSearchParams(String(init.body))));
  return new Response('OK', { status: 200 });
};
let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log(`PASS ${label}`); }
const DAY = 86_400_000;
function signedResult(fields) {
  const suffix = Object.keys(fields).filter(key => /^shp_/i.test(key)).sort().map(key => `${key}=${fields[key]}`).join(':');
  const SignatureValue = createHash('md5').update(`${fields.OutSum}:${fields.InvId}:${process.env.ROBOKASSA_PASSWORD2}${suffix ? `:${suffix}` : ''}`).digest('hex');
  return { ...fields, SignatureValue };
}
const deliver = fields => webhook.POST(new NextRequest('http://localhost/api/payment/webhook', { method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(signedResult(fields)).toString() }));
async function subscriber(end) {
  return db.user.create({ data: { email: `renew-${Math.random().toString(36).slice(2)}@example.test`, subscriptionType: 'universe',
    subscriptionEnd: end, isSubscribed: true, robokassaRecurringId: String(1_900_000_000 + Math.floor(Math.random() * 90_000_000)),
    verseCoins: 100, permanentCoins: 100 } });
}
const resultFor = (charge) => Object.fromEntries(Object.entries(charge).filter(([key]) => key === 'OutSum' || key === 'InvId' || /^Shp_/.test(key)));
try {
  await check('cron renewal followed by the Robokassa confirmation extends exactly one period and grants VC once', async () => {
    const now = new Date(), end = new Date(now.getTime() + 3_600_000), user = await subscriber(end);
    const result = await renewal.renewSubscriptionIfDue(user.id, { now });
    assert.equal(result.renewed, true);
    const afterCron = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(afterCron.subscriptionEnd.getTime(), end.getTime() + 30 * DAY);
    const charge = charges.at(-1); assert.equal(charge.InvoiceID, result.invId);
    const response = await deliver(resultFor(charge));
    assert.equal(response.status, 200); assert.match(await response.text(), new RegExp(`^OK${result.invId}`));
    const afterWebhook = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(afterWebhook.subscriptionEnd.getTime(), afterCron.subscriptionEnd.getTime(), 'the webhook must not add a second period');
    assert.equal(afterWebhook.verseCoins, afterCron.verseCoins, 'the webhook must not grant the plan VC a second time');
    assert.equal(await db.transaction.count({ where: { userId: user.id, description: `Robokassa InvId=${result.invId}` } }), 1);
    const event = await db.paymentEvent.findUniqueOrThrow({ where: { provider_invoiceId: { provider: 'robokassa', invoiceId: result.invId } } });
    assert.equal(event.kind, 'subscription_renewal'); assert.equal(event.userId, user.id); assert.equal(event.planId, 'universe');
    const replay = await deliver(resultFor(charge));
    assert.equal(replay.status, 200);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).subscriptionEnd.getTime(), afterCron.subscriptionEnd.getTime());
  });
  await check('a renewal confirmed only by the webhook still extends one period', async () => {
    const end = new Date(Date.now() + 5 * DAY), user = await subscriber(end);
    const response = await deliver({ OutSum: `${getSubscriptionPlan('universe').monthlyPrice}.00`, InvId: '777000111', Shp_userId: user.id,
      Shp_subscription: 'true', Shp_plan: 'universe', Shp_period: 'month', Shp_applyMode: 'immediate' });
    assert.equal(response.status, 200);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(after.subscriptionEnd.getTime(), end.getTime() + 30 * DAY);
    assert.ok(after.verseCoins > user.verseCoins, 'a genuine renewal still grants the plan VC');
  });
  await check('a cron renewal whose webhook already arrived does not apply again', async () => {
    const now = new Date(), end = new Date(now.getTime() + 3_600_000), user = await subscriber(end);
    // Webhook-first ordering: let the cron create the invoice id, then deliver and re-run the cron grant.
    globalThis.fetch = async (url, init) => { charges.push(Object.fromEntries(new URLSearchParams(String(init.body)))); return new Response('OK'); };
    const first = await renewal.renewSubscriptionIfDue(user.id, { now, force: true, ignoreInitiated: true });
    const once = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    await deliver(resultFor(charges.at(-1)));
    const again = await renewal.renewSubscriptionIfDue(user.id, { now: new Date(now.getTime() + 1000) });
    assert.equal(again.renewed, false); assert.equal(again.reason, 'not_due');
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).subscriptionEnd.getTime(), once.subscriptionEnd.getTime());
    assert.equal(first.renewed, true);
  });
  console.log(`Subscription renewal: ${passed} checks passed`);
} finally { globalThis.fetch = realFetch; await h.stop(); }
