// Real renewal cron, OpStateExt reconciliation and Robokassa webhook on disposable PostgreSQL. No network, no .env.
// Regressions for 2026-10-21: a renewal was granted by the cron AND the webhook (+60 days), and the cron granted
// the period when it merely sent a charge that might still fail.
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
const charges = [], stateQueries = [];
let invoiceState = { result: 0, state: 5 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target === 'https://auth.robokassa.ru/Merchant/Recurring') {
    charges.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    return new Response('OK' + charges.at(-1).InvoiceID, { status: 200 });
  }
  if (target.startsWith('https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpStateExt?')) {
    const params = new URL(target).searchParams;
    stateQueries.push(params.get('InvoiceID'));
    assert.equal(params.get('Signature'), createHash('md5').update(`synthetic_merchant:${params.get('InvoiceID')}:synthetic_result_password`).digest('hex'));
    const state = invoiceState.state === null ? '' : `<State><Code>${invoiceState.state}</Code></State>`;
    const amount = invoiceState.amount ?? charges.find(charge => charge.InvoiceID === params.get("InvoiceID"))?.OutSum;
    const info = `<Info><OutCurrLabel>${invoiceState.currency ?? "RUR"}</OutCurrLabel><OutSum>${amount}</OutSum></Info>`;
    return new Response(`<?xml version="1.0"?><OperationStateResponse><Result><Code>${invoiceState.result}</Code></Result>${state}${info}</OperationStateResponse>`);
  }
  throw new Error(`External network forbidden: ${target}`);
};
let passed = 0;
async function check(label, fn) { await fn(); passed++; console.log(`PASS ${label}`); }
const DAY = 86_400_000, MIN = 60_000;
function signedResult(fields) {
  const suffix = Object.keys(fields).filter(key => /^shp_/i.test(key)).sort().map(key => `${key}=${fields[key]}`).join(':');
  const SignatureValue = createHash('md5').update(`${fields.OutSum}:${fields.InvId}:${process.env.ROBOKASSA_PASSWORD2}${suffix ? `:${suffix}` : ''}`).digest('hex');
  return { ...fields, SignatureValue };
}
const deliver = fields => webhook.POST(new NextRequest('http://localhost/api/payment/webhook', { method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(signedResult(fields)).toString() }));
const resultFor = charge => Object.fromEntries(Object.entries(charge).filter(([key]) => key === 'OutSum' || key === 'InvId' || /^Shp_/.test(key)));
async function subscriber(end, plan = 'universe') {
  const account = await db.user.create({ data: { email: `renew-${Math.random().toString(36).slice(2)}@example.test`, subscriptionType: plan,
    subscriptionEnd: end, isSubscribed: true, robokassaRecurringId: String(1_900_000_000 + Math.floor(Math.random() * 90_000_000)),
    verseCoins: 100, permanentCoins: 100 } });
  await db.paymentEvent.create({data:{userId:account.id,provider:"robokassa",invoiceId:account.robokassaRecurringId,kind:"subscription",planId:plan,amountRub:getSubscriptionPlan(plan).monthlyPrice}});
  return account;
}
const user = id => db.user.findUniqueOrThrow({ where: { id } });
// Initiated markers carry the real clock; age them to emulate a later cron run.
const ageInitiated = (userId, ms) => db.$executeRaw`UPDATE "Transaction" SET "createdAt" = "createdAt" - (${ms} * interval '1 millisecond') WHERE "userId" = ${userId} AND type = 'subscription_renewal_initiated'`;
try {
  await check('sending a charge grants nothing; the Robokassa confirmation grants one period and VC once', async () => {
    const now = new Date(), end = new Date(now.getTime() + 3_600_000), u = await subscriber(end);
    const sent = await renewal.renewSubscriptionIfDue(u.id, { now });
    assert.equal(sent.renewed, false); assert.equal(sent.initiated, true);
    assert.equal(charges.at(-1).Shp_renewal, 'true');
    const afterCharge = await user(u.id);
    assert.equal(afterCharge.subscriptionEnd.getTime(), end.getTime(), 'no period before confirmation');
    assert.equal(afterCharge.verseCoins, 100);
    const response = await deliver(resultFor(charges.at(-1)));
    assert.equal(response.status, 200); assert.match(await response.text(), new RegExp(`^OK${sent.invId}`));
    const confirmed = await user(u.id);
    assert.equal(confirmed.subscriptionEnd.getTime(), end.getTime() + 30 * DAY);
    assert.ok(confirmed.verseCoins > 100); assert.equal(confirmed.robokassaRecurringId, u.robokassaRecurringId, 'series id is kept');
    assert.equal(await db.transaction.count({ where: { userId: u.id, description: `Robokassa InvId=${sent.invId}` } }), 1);
    assert.equal((await db.paymentEvent.findUniqueOrThrow({ where: { provider_invoiceId: { provider: 'robokassa', invoiceId: sent.invId } } })).kind, 'subscription_renewal');
    await deliver(resultFor(charges.at(-1)));
    assert.equal((await user(u.id)).subscriptionEnd.getTime(), confirmed.subscriptionEnd.getTime(), 'a replayed ResultURL adds nothing');
  });
  await check('a lost ResultURL never causes a second charge; the paid state grants once, from the charge time', async () => {
    const now = new Date(), end = new Date(now.getTime() + 3_600_000), u = await subscriber(end);
    const sent = await renewal.renewSubscriptionIfDue(u.id, { now });
    const chargesBefore = charges.length;
    invoiceState = { result: 0, state: 5 };
    // Within the grace period nobody is asked; the charge is simply pending.
    const early = await renewal.renewSubscriptionIfDue(u.id, { now: new Date(now.getTime() + 5 * MIN) });
    assert.equal(early.reason, 'awaiting_confirmation'); assert.equal(charges.length, chargesBefore);
    // A day later with the period lapsed and the money taken: reconcile, no new charge.
    await ageInitiated(u.id, 26 * 3_600_000);
    invoiceState = { result: 0, state: 100 };
    const later = new Date(now.getTime() + 26 * 3_600_000);
    const summary = await renewal.renewDueSubscriptions(later);
    assert.ok(summary.reconciled.some(row => row.userId === u.id && row.outcome === 'granted'));
    assert.equal(charges.length, chargesBefore, 'reconciliation never charges');
    const granted = await user(u.id);
    assert.equal(granted.subscriptionEnd.getTime(), end.getTime() + 30 * DAY, 'extended from the old end, no paid days lost');
    await deliver(resultFor(charges[chargesBefore - 1]));
    assert.equal((await user(u.id)).subscriptionEnd.getTime(), granted.subscriptionEnd.getTime(), 'a late ResultURL adds nothing');
    assert.ok(stateQueries.includes(sent.invId));
  });
  await check('a declined charge grants nothing and is retried only after the 24 h back-off', async () => {
    const now = new Date(), end = new Date(now.getTime() + 3_600_000), u = await subscriber(end);
    await renewal.renewSubscriptionIfDue(u.id, { now });
    await ageInitiated(u.id, 20 * MIN);
    invoiceState = { result: 0, state: 10 };
    const chargesBefore = charges.length;
    const soon = await renewal.renewSubscriptionIfDue(u.id, { now: new Date(now.getTime() + 20 * MIN) });
    assert.equal(soon.reason, 'already_initiated'); assert.equal(charges.length, chargesBefore);
    assert.equal(await db.transaction.count({ where: { userId: u.id, type: 'subscription_renewal_declined' } }), 1);
    assert.equal((await user(u.id)).subscriptionEnd.getTime(), end.getTime(), 'a declined charge gives no period');
    await ageInitiated(u.id, 25 * 3_600_000);
    const retry = await renewal.renewSubscriptionIfDue(u.id, { now: new Date(now.getTime() + 25 * 3_600_000) });
    assert.equal(retry.initiated, true); assert.equal(charges.length, chargesBefore + 1);
  });
  await check('an operation still in progress is neither granted nor charged again, even in force mode', async () => {
    const now = new Date(), end = new Date(now.getTime() + 3_600_000), u = await subscriber(end);
    await renewal.renewSubscriptionIfDue(u.id, { now });
    await ageInitiated(u.id, 30 * 3_600_000);
    const chargesBefore = charges.length;
    for (const state of [{ result: 0, state: 50 }, { result: 1000, state: null }]) {
      invoiceState = state;
      const result = await renewal.renewSubscriptionIfDue(u.id, { now: new Date(now.getTime() + 30 * 3_600_000), force: true });
      assert.equal(result.reason, 'awaiting_confirmation');
    }
    assert.equal(charges.length, chargesBefore);
    assert.equal((await user(u.id)).subscriptionEnd.getTime(), end.getTime());
  });
  await check('an unknown signed renewal cannot grant a period', async () => {
    const end = new Date(Date.now() + 5 * DAY), u = await subscriber(end, 'dialog');
    const response = await deliver({ OutSum: "499.00", InvId: "777000111", Shp_userId: u.id,
      Shp_subscription: "true", Shp_plan: "dialog", Shp_period: "month", Shp_applyMode: "immediate", Shp_renewal: "true" });
    assert.equal(response.status, 409);
    assert.equal((await user(u.id)).subscriptionEnd.getTime(), end.getTime());
  });
  await check('concurrent cron runs reserve and send only one child invoice', async () => {
    const end = new Date(Date.now() + 3_600_000), u = await subscriber(end, 'dialog');
    const before = charges.length;
    const results = await Promise.all(Array.from({length: 5}, () => renewal.renewSubscriptionIfDue(u.id)));
    assert.equal(results.filter(r => r.initiated).length, 1);
    assert.equal(charges.length, before + 1);
    assert.equal(await db.transaction.count({where:{userId:u.id,type:"subscription_renewal_initiated"}}),1);
  });
  await check('mismatched amount or currency does not settle a pending invoice', async () => {
    const end = new Date(Date.now() + 3_600_000), u = await subscriber(end, 'dialog');
    const sent = await renewal.renewSubscriptionIfDue(u.id);
    const charge = resultFor(charges.at(-1));
    assert.equal((await deliver({...charge, OutSum:"1.00"})).status,409);
    await ageInitiated(u.id, 20 * MIN);
    for (const state of [{result:0,state:100,amount:"1.00"},{result:0,state:100,currency:"USD"}]) {
      invoiceState = state;
      assert.equal((await renewal.renewSubscriptionIfDue(u.id)).reason,"awaiting_confirmation");
      assert.equal((await user(u.id)).subscriptionEnd.getTime(),end.getTime());
    }
    assert.equal(await db.paymentEvent.count({where:{invoiceId:sent.invId}}),0);
    assert.equal((await deliver(charge)).status,200);
  });
  await check('an in-flight paid renewal preserves the cancellation of future payments', async () => {
    const end = new Date(Date.now() + 3_600_000), u = await subscriber(end, 'dialog');
    await renewal.renewSubscriptionIfDue(u.id);
    const charge = resultFor(charges.at(-1));
    await db.user.update({where:{id:u.id},data:{robokassaRecurringId:null}});
    assert.equal((await deliver({...charge,RecurringID:"987"})).status,200);
    assert.equal((await deliver({...charge,RecurringID:"987"})).status,200);
    assert.equal((await user(u.id)).robokassaRecurringId,null);
    assert.equal((await user(u.id)).subscriptionEnd.getTime(),end.getTime()+30*DAY);
  });
  await check('a server record of a paid parent is required before sending a renewal', async () => {
    const end = new Date(Date.now() + 3_600_000), u = await subscriber(end, 'dialog');
    await db.paymentEvent.deleteMany({where:{userId:u.id}});
    const before = charges.length;
    assert.equal((await renewal.renewSubscriptionIfDue(u.id)).reason,"no_confirmed_agreement");
    assert.equal(charges.length,before);
  });
  await check('a historical paid parent with a matching activation and renewal remains eligible', async () => {
    const u = await subscriber(new Date(Date.now() + 3_600_000), 'dialog');
    await db.paymentEvent.deleteMany({where:{userId:u.id}});
    const initial = new Date(Date.now() - 60*DAY);
    await db.transaction.createMany({data:[
      {userId:u.id,amount:0,type:"subscription",description:"Robokassa InvId="+u.robokassaRecurringId,createdAt:initial},
      {userId:u.id,amount:2500,type:"subscription_activated",description:"Зачислено 2500 VC по тарифу «Диалог»",createdAt:initial},
    ]});
    await db.paymentEvent.create({data:{userId:u.id,provider:"robokassa",invoiceId:"777000222",kind:"subscription_renewal",
      planId:"dialog",amountRub:499,createdAt:new Date(Date.now()-30*DAY)}});
    assert.equal((await renewal.renewSubscriptionIfDue(u.id)).initiated,true);
    assert.equal(charges.at(-1).PreviousInvoiceID,u.robokassaRecurringId);
    assert.equal(charges.at(-1).OutSum,"499.00");
  });
  console.log(`Subscription renewal: ${passed} checks passed`);
} finally { globalThis.fetch = realFetch; await h.stop(); }
