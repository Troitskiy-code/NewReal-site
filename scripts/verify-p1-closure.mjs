import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
const require = createRequire(import.meta.url);

export async function verifyP1Closure({ db, load, check, cache, databaseUrl, schemaPath }) {
  const { verifyP1MigrationUpgrade } = await import('./verify-p1-migration-upgrade.mjs');
  await verifyP1MigrationUpgrade({ databaseUrl, schemaPath, check });
  const migrated = await db.$queryRawUnsafe('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL');
  check(migrated.some(r => r.migration_name === '20260801000000_baseline')
    && migrated.some(r => r.migration_name === '20261002120000_p1_operational_closure'), 'fresh database deploys baseline and every migration');
  const rate = load('src/lib/rateLimit.ts');
  const concurrent = await Promise.all(Array.from({ length: 30 }, () => rate.consumeRateLimit('closure-shared', 5, 60000)));
  check(concurrent.filter(r => r.ok).length === 5, '30 concurrent requests share exactly five rate-limit slots');
  const hash = createHash('sha256').update('closure-shared').digest('hex');
  check((await db.rateLimitBucket.findUniqueOrThrow({ where: { key: hash } })).count === 6, 'rate-limit storage is hashed and bounded');
  await db.rateLimitBucket.update({ where: { key: hash }, data: { resetAt: new Date(0) } });
  check((await rate.consumeRateLimit('closure-shared', 5, 60000)).ok, 'expired database bucket resets');
  process.env.TRUST_PROXY = '';
  check(rate.clientKeyFromRequest({ headers: new Headers({ 'x-forwarded-for': 'attacker' }) }) === 'unknown', 'untrusted forwarded header cannot evade limits');
  process.env.TRUST_PROXY = '1';
  check(rate.clientKeyFromRequest({ headers: new Headers({ 'x-forwarded-for': '192.0.2.1, 192.0.2.2' }) }) === '192.0.2.1', 'explicitly trusted proxy supplies client key');

  process.env.SUPPORT_INBOX_EMAIL = 'inbox@example.test';
  const support = load('src/lib/supportOutbox.ts', { '@/lib/logger': { errorLog() {}, infoLog() {} } });
  const input = { clientKey: 'closure-support-key', email: 'customer@example.test', topic: 'technical', message: 'Synthetic support test', userId: null };
  const tickets = await Promise.all([support.createOrReplaySupportTicket(input), support.createOrReplaySupportTicket(input)]);
  check(tickets[0].ticketId === tickets[1].ticketId, 'concurrent support submission creates one ticket');
  check('conflict' in await support.createOrReplaySupportTicket({ ...input, message: 'Changed support payload' }), 'support key cannot silently replace a payload');
  const draft = load('src/lib/supportDraft.ts');
  const payload = draft.supportSubmissionPayload(input.topic, input.email, input.message);
  check(draft.supportSubmissionKey(input.clientKey, payload, payload) === input.clientKey, 'support lost response keeps submission key');
  check(draft.supportSubmissionKey(input.clientKey, payload, payload + 'changed') !== input.clientKey, 'edited support draft gets a new key');
  const [c1, c2] = await Promise.all([support.claimSupportDeliveries(), support.claimSupportDeliveries()]);
  check(c1.length + c2.length === 1, 'two outbox workers claim a ticket once');
  const claimed = [...c1, ...c2][0];
  const providerKeys = new Set(); let remoteDeliveries = 0;
  const provider = async p => { if (!providerKeys.has(p.idempotencyKey)) { providerKeys.add(p.idempotencyKey); remoteDeliveries++; throw new Error('Response lost after delivery'); } };
  check(await support.deliverSupportTicket(claimed, provider) === 'retry', 'lost provider response schedules retry');
  await db.supportTicket.update({ where: { id: claimed.id }, data: { nextAttemptAt: new Date(0) } });
  const replay = (await support.claimSupportDeliveries())[0];
  check(await support.deliverSupportTicket(replay, provider) === 'sent' && remoteDeliveries === 1, 'provider retry reuses stable idempotency key');
  const terminal = await db.supportTicket.create({ data: { ...input, clientKey: 'closure-terminal-key', deliveryAttempts: 5 } });
  const terminalClaim = (await support.claimSupportDeliveries())[0];
  check(await support.deliverSupportTicket(terminalClaim, async () => { throw new Error('Provider down'); }) === 'dead', 'sixth failed delivery enters terminal state');
  const attention = await support.processSupportOutbox();
  check(attention.requiresAttention && attention.reviewTicketIds.includes(terminal.id), 'terminal deliveries are exposed for cron alert');
  await db.supportTicket.create({ data: { ...input, clientKey: 'closure-old-key', createdAt: new Date(Date.now() - 24 * 3600000) } });
  check((await support.claimSupportDeliveries()).length === 0, 'outbox stops before provider idempotency expires');
  await db.supportTicket.updateMany({ data: { deliveryStatus: 'sent' } });

  // An upgrade fixture actually contains historical rows (unlike SELECT ... LIMIT 0).
  const legacyUser = await db.user.create({ data: { id: 'closure-legacy-user', email: 'legacy@example.test' } });
  await db.transaction.create({ data: { userId: legacyUser.id, amount: 100, type: 'purchase', description: 'Robokassa InvId=4242' } });
  await db.anonymousSession.create({ data: { sessionId: 'closure-legacy', messagesCount: 2 } });
  await db.anonymousChatRequest.create({ data: { sessionId: 'closure-legacy', requestId: 'legacy-done', characterId: 'legacy-character', status: 'completed', userContent: 'hello', assistantContent: 'historical reply' } });
  await db.anonymousChatRequest.create({ data: { sessionId: 'closure-legacy', requestId: 'legacy-pending', characterId: 'legacy-character', status: 'pending', userContent: 'waiting' } });
  await db.supportTicket.create({ data: { topic: 'technical', email: 'legacy@example.test', message: 'Historical support ticket' } });
  await db.$executeRawUnsafe('DROP TABLE "PaymentEvent"');
  for (const column of ['payloadHash', 'attempt', 'leaseUntil', 'reservedQuota', 'refundedAt']) {
    await db.$executeRawUnsafe(`ALTER TABLE "AnonymousChatRequest" DROP COLUMN "${column}"`);
  }
  const { Client } = require('pg'); const sql = new Client({ connectionString: databaseUrl }); await sql.connect();
  try {
    for (const name of ['20261001180000_p0_p1_rework', '20261001210000_payment_event_analytics', '20261002120000_p1_operational_closure']) {
      await sql.query(readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'));
    }
  } finally { await sql.end(); }
  check((await db.paymentEvent.findUniqueOrThrow({ where: { provider_invoiceId: { provider: 'robokassa', invoiceId: '4242' } } })).userId === legacyUser.id, 'historical payment marker is backfilled');
  const legacy = await db.anonymousChatRequest.findUniqueOrThrow({ where: { sessionId_requestId: { sessionId: 'closure-legacy', requestId: 'legacy-pending' } } });
  check(legacy.payloadHash === createHash('sha256').update('legacy-character\nwaiting').digest('hex')
    && legacy.status === 'failed' && legacy.reservedQuota, 'legacy pending request becomes retryable with its original reservation');
  check((await db.anonymousSession.findUniqueOrThrow({ where: { sessionId: 'closure-legacy' } })).messagesCount === 2, 'upgrade does not invent guest quota refunds');
  check((await db.anonymousChatRequest.findUniqueOrThrow({ where: { sessionId_requestId: { sessionId: 'closure-legacy', requestId: 'legacy-done' } } })).assistantContent === 'historical reply', 'upgrade preserves completed guest reply');
  const legacyStore = load('src/lib/guestRequestStore.ts');
  check((await legacyStore.claimGuestGeneration({ sessionId: 'closure-legacy', requestId: 'legacy-done',
    characterId: 'legacy-character', message: 'hello', quotaLimit: 2 })).kind === 'replay', 'upgraded completed request actually replays at exhausted quota');
  const legacyRetry = await legacyStore.claimGuestGeneration({ sessionId: 'closure-legacy', requestId: 'legacy-pending',
    characterId: 'legacy-character', message: 'waiting', quotaLimit: 2 });
  check(legacyRetry.kind === 'run' && legacyRetry.attempt === 2
    && (await db.anonymousSession.findUniqueOrThrow({ where: { sessionId: 'closure-legacy' } })).messagesCount === 2,
    'upgraded pending request actually retries without double reservation');
  await legacyStore.failGuestGeneration({ sessionId: 'closure-legacy', requestId: 'legacy-pending', attempt: 2 });
  const preflight = spawnSync(process.execPath, ['scripts/migration-preflight.mjs', '--ready'], {
    env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  check(preflight.status === 0, `read-only schema preflight accepts migrated fixture: ${preflight.stderr}`);
  check(await db.supportTicket.count({ where: { deliveryStatus: 'manual_review' } }) === 1, 'legacy support delivery requires review instead of duplicate mail');

  process.env.ROBOKASSA_PASSWORD = 'synthetic_checkout_password';
  process.env.ROBOKASSA_PASSWORD2 = 'synthetic_result_password';
  process.env.ROBOKASSA_PASSWORD3 = 'synthetic_unrelated_password';
  const webhook = load('src/app/api/payment/webhook/route.ts', { '@/lib/logger': { errorLog() {}, infoLog() {}, toSafeDiagnostic: () => ({ category: 'error' }) } });
  const { NextRequest } = require('next/server');
  const customer = await db.user.create({ data: { email: 'payment@example.test', verseCoins: 20, permanentCoins: 20 } });
  function signed(invId, shp, extra = {}, password = process.env.ROBOKASSA_PASSWORD2) {
    const fields = { OutSum: '129.00', InvId: invId, ...shp, ...extra };
    const suffix = Object.keys(fields).filter(k => /^shp_/i.test(k)).sort().map(k => `${k}=${fields[k]}`).join(':');
    fields.SignatureValue = createHash('md5').update(`${fields.OutSum}:${fields.InvId}:${password}:${suffix}`).digest('hex');
    return fields;
  }
  const vc = { Shp_userId: customer.id, Shp_vc: '100' };
  async function http(fields, mode = 'form') {
    const base = 'http://localhost/api/payment/webhook';
    const req = mode === 'get' ? new NextRequest(base + '?' + new URLSearchParams(fields))
      : new NextRequest(base, { method: 'POST', headers: { 'content-type': mode === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' }, body: mode === 'json' ? JSON.stringify(fields) : new URLSearchParams(fields).toString() });
    return mode === 'get' ? webhook.GET(req) : webhook.POST(req);
  }
  const tampered = signed('9001', vc); tampered.OutSum = '999.00';
  check((await http(tampered)).status === 403, 'HTTP webhook rejects amount tampering');
  check((await http(signed('9001', vc, {}, process.env.ROBOKASSA_PASSWORD))).status === 403, 'HTTP webhook rejects checkout password');
  const withoutShp = signed('9001', {}); withoutShp.Shp_userId = customer.id; withoutShp.Shp_vc = '100';
  check((await http(withoutShp)).status === 403, 'HTTP webhook rejects unsigned Shp fields');
  const replies = await Promise.all([http(signed('9001', vc)), http(signed('9001', vc), 'json'), http(signed('9001', vc), 'get')]);
  check(replies.every(r => r.status === 200), 'form/json/GET concurrent signed webhooks acknowledge replay');
  check((await db.user.findUniqueOrThrow({ where: { id: customer.id } })).permanentCoins === 120
    && await db.paymentEvent.count({ where: { invoiceId: '9001' } }) === 1
    && await db.notification.count({ where: { userId: customer.id } }) === 1, 'three deliveries produce one grant/event/notification');
  const simultaneous = await Promise.all([http(signed('9002', vc)), http(signed('9003', vc))]);
  check(simultaneous.every(r => r.status === 200) && (await db.user.findUniqueOrThrow({ where: { id: customer.id } })).permanentCoins === 320, 'different concurrent invoices preserve both VC grants');
  const other = await db.user.create({ data: { email: 'other@example.test' } });
  check((await http(signed('9001', { ...vc, Shp_userId: other.id }))).status === 409, 'existing invoice cannot move to another account');
  const sub = { Shp_userId: customer.id, Shp_subscription: 'true', Shp_plan: 'dialog', Shp_period: 'month' };
  check((await http(signed('9010', sub))).status === 200, 'real signed handler activates subscription');
  const active = await db.user.findUniqueOrThrow({ where: { id: customer.id } });
  check(active.subscriptionType === 'dialog' && active.permanentCoins === 320 && active.subscriptionEnd > new Date(), 'subscription keeps permanent VC and sets expiry');
  check((await http(signed('9011', sub, { RecurringID: '9010' }))).status === 200, 'real handler accepts signed recurring renewal');
  const renewed = await db.user.findUniqueOrThrow({ where: { id: customer.id } });
  check(renewed.subscriptionEnd.getTime() - active.subscriptionEnd.getTime() === 30 * 86400000, 'renewal extends subscription by thirty days');
  const pending = { ...sub, Shp_plan: 'universe', Shp_applyMode: 'afterExpiry' };
  check((await http(signed('9012', pending))).status === 200, 'after-expiry purchase is recorded');
  const queued = await db.user.findUniqueOrThrow({ where: { id: customer.id } });
  check(queued.subscriptionType === 'dialog' && queued.pendingSubscriptionType === 'universe' && queued.verseCoins === renewed.verseCoins, 'pending upgrade neither overwrites active plan nor grants early VC');
  const events = await db.paymentEvent.findMany({ where: { invoiceId: { in: ['9010', '9011', '9012'] } } });
  check(events.every(e => e.planId && e.amountRub === 129) && new Set(events.map(e => e.kind)).size === 3, 'activation/renewal/pending retain server analytics metadata');
  const fault = new Client({ connectionString: databaseUrl }); await fault.connect();
  try {
    const balanceBefore = (await db.user.findUniqueOrThrow({ where: { id: customer.id } })).verseCoins;
    await fault.query(`CREATE FUNCTION closure_notification_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic notification failure'; END $$`);
    await fault.query('CREATE TRIGGER closure_notification_failure BEFORE INSERT ON "Notification" FOR EACH ROW EXECUTE FUNCTION closure_notification_failure()');
    check((await http(signed('9030', vc))).status === 500, 'webhook reports database failure instead of false acknowledgement');
    check(await db.paymentEvent.count({ where: { invoiceId: '9030' } }) === 0
      && (await db.user.findUniqueOrThrow({ where: { id: customer.id } })).verseCoins === balanceBefore, 'notification failure rolls back event, grant and transaction');
    await fault.query('DROP TRIGGER closure_notification_failure ON "Notification"');
    check((await http(signed('9030', vc))).status === 200, 'provider retry succeeds once after transaction rollback');
  } finally { await fault.end(); }
  const activation = load('src/lib/subscription.ts', { '@/lib/robokassa': { cancelRobokassaRecurring: async () => true } });
  const expired = await db.user.update({ where: { id: customer.id }, data: {
    subscriptionEnd: new Date(Date.now() - 1000), robokassaRecurringId: null,
  } });
  const permanentBefore = expired.permanentCoins;
  const switching = await Promise.all([activation.activatePendingSubscriptionIfNeeded(expired),
    http(signed('9031', vc)), activation.activatePendingSubscriptionIfNeeded(expired)]);
  const switched = await db.user.findUniqueOrThrow({ where: { id: customer.id } });
  check(switching.filter(r => r === true).length === 1 && switching[1].status === 200,
    'concurrent pending activation runs once alongside a signed VC purchase');
  check(switched.subscriptionType === 'universe' && switched.pendingSubscriptionType === null
    && switched.permanentCoins === permanentBefore + 100, 'pending activation preserves concurrently purchased permanent VC');

  process.env.NEXTAUTH_SECRET = 'synthetic_auth_callback_only';
  const auth = load('src/lib/auth.ts', { 'next/headers': { cookies: async () => ({ get: () => undefined }) } });
  const loginToken = await auth.authOptions.callbacks.jwt({ token: {}, user: legacyUser, account: { provider: 'google' } });
  check(typeof loginToken.oauthLoginEventId === 'string', 'real JWT callback stamps successful Google login event');
  const resumedToken = await auth.authOptions.callbacks.jwt({ token: loginToken });
  check(resumedToken.oauthLoginEventId === loginToken.oauthLoginEventId, 'JWT session refresh retains OAuth event without creating another');
  const credentialsToken = await auth.authOptions.callbacks.jwt({ token: { ...loginToken }, user: other, account: { provider: 'credentials' } });
  check(credentialsToken.oauthLoginEventId === undefined, 'credentials login clears any prior OAuth success event');
  const ddl = new Client({ connectionString: databaseUrl }); await ddl.connect();
  try {
    await ddl.query(`CREATE ROLE nv_p1_app LOGIN PASSWORD 'synthetic_app_role' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await ddl.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await ddl.query('GRANT USAGE ON SCHEMA public TO nv_p1_app');
    await ddl.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nv_p1_app');
  } finally { await ddl.end(); }
  const limitedUrl = new URL(databaseUrl); limitedUrl.username = 'nv_p1_app'; limitedUrl.password = 'synthetic_app_role';
  limitedUrl.searchParams.set('connection_limit', '1');
  const limited = new PrismaClient({ datasourceUrl: limitedUrl.toString(), log: [] });
  try {
    await assert.rejects(() => limited.$executeRawUnsafe('CREATE TABLE forbidden_runtime_ddl (id int)'));
    check(true, 'application role is actually denied DDL');
    // Rebind the shared Prisma object rather than mocking its query behavior.
    const originalTransaction = db.$transaction.bind(db);
    db.$transaction = limited.$transaction.bind(limited);
    try { check((await http(signed('9020', vc))).status === 200, 'real webhook works with no-DDL application role'); }
    finally { db.$transaction = originalTransaction; }
    for (const name of ['ensureEmailVerification', 'ensureUserConsent', 'ensureMemoryHierarchyColumns', 'ensureCharacterModerationColumns', 'ensureNotificationTable', 'ensureCharacterLocaleColumns', 'ensureCharacterSlug']) {
      cache.delete(resolve(`src/lib/${name}.ts`));
      const guard = load(`src/lib/${name}.ts`);
      const originalQuery = db.$queryRawUnsafe.bind(db); db.$queryRawUnsafe = limited.$queryRawUnsafe.bind(limited);
      try {
        const fn = Object.values(guard).find(value => typeof value === 'function' && value.name.startsWith('ensure'));
        assert.ok(fn, name); await fn();
      } finally { db.$queryRawUnsafe = originalQuery; }
    }
    check(true, 'all schema guards run read-only under application role');
  } finally { await limited.$disconnect(); }
  return { limitedDatabaseUrl: limitedUrl.toString() };
}
