// Real handlers, transport, quota transactions and SQL on disposable PostgreSQL.
// All Kie/image requests are intercepted; no .env, production DB or paid calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import ts from 'typescript';
import sharp from 'sharp';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { NextRequest } from 'next/server.js';
import { buildAiCostReport } from './lib/ai-cost-report.mjs';

const require = createRequire(import.meta.url);
const runtime = process.env['GUEST_TEST_RUNTIME'] || join(tmpdir(), 'nv-p1-isolated-runtime');
const EmbeddedPostgres = require(join(resolve(runtime), 'node_modules/embedded-postgres/dist/index.js')).default;
const portServer = createServer(); await new Promise(r => portServer.listen(0, '127.0.0.1', r));
const port = portServer.address().port; await new Promise(r => portServer.close(r));
const directory = mkdtempSync(join(tmpdir(), 'nv-kie-'));
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_fixture',
  port, persistent: true, onLog() {}, initdbFlags: ['--encoding=UTF8'] });
const databaseUrl = `postgresql://postgres:synthetic_fixture@127.0.0.1:${port}/nv_kie_test`;
const db = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
const ddl = new Client({ connectionString: databaseUrl });
const testEnv = { KIE_API_KEY: 'synthetic_fixture_key', KIE_WEBHOOK_HMAC_KEY: 'synthetic_fixture_hmac',
  NEXTAUTH_URL: 'https://example.test', NEXTAUTH_SECRET: 'synthetic_fixture_actor', CRON_SECRET: 'synthetic_fixture_cron' };
const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#789abc' } }).png().toBuffer();
const reference = `data:image/png;base64,${png.toString('base64')}`;
const marker = 'SYNTHETIC_PRIVATE_PROMPT';
const logs = [];
const fakeConsole = Object.fromEntries(['log','info','warn','error','debug'].map(name => [name, (...args) => logs.push(args.map(String).join(' '))]));
let userId, creates = 0, uploads = 0, state = 'success', createMode = 'ok', downloadFails = false;
const tasks = new Map();
const requests = [];
const json = (value, status = 200) => Response.json(value, { status });
async function providerFetch(url, init = {}) {
  const parsed = new URL(url);
  if (parsed.host === 'kieai.redpandaai.co' && parsed.pathname === '/api/file-base64-upload') {
    uploads++; const body = JSON.parse(init.body);
    assert.ok(body.base64Data.startsWith('data:image/png;base64,'));
    return json({ code: 200, data: { downloadUrl: `https://tempfile.redpandaai.co/${body.fileName}` } });
  }
  if (parsed.host === 'api.kie.ai' && parsed.pathname === '/api/v1/jobs/createTask') {
    creates++; const body = JSON.parse(init.body); requests.push(body);
    assert.equal(init.redirect, 'error');
    if (createMode === 'lost') throw new Error(marker);
    if (createMode === 'reject') return json({ code: 402, msg: marker });
    if (createMode === 'malformed') return json({ code: 200, msg: marker });
    const taskId = `fixture_task_${creates}`;
    tasks.set(taskId, { model: body.model }); return json({ code: 200, data: { taskId } });
  }
  if (parsed.host === 'api.kie.ai' && parsed.pathname === '/api/v1/jobs/recordInfo') {
    const taskId = parsed.searchParams.get('taskId');
    return json({ code: 200, data: { taskId, model: tasks.get(taskId).model, state,
      creditsConsumed: state === 'fail' ? 0 : 4, failMsg: marker,
      resultJson: JSON.stringify({ resultUrls: ['https://tempfile.aiquickdraw.com/image.png'] }) } });
  }
  if (parsed.host === 'tempfile.aiquickdraw.com') {
    if (downloadFails) throw new Error(marker);
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  }
  throw new Error('External network forbidden: ' + parsed.host);
}
const cache = new Map();
function load(file) {
  file = resolve(file); if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} }; cache.set(file, mod.exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const dependency = name => {
    if (name === '@/lib/prisma' || name === './prisma') return { prisma: db };
    if (name === '@/lib/auth') return { authOptions: {} };
    if (name === 'next-auth/next') return { getServerSession: async () => userId ? { user: { id: userId } } : null };
    if (name === './currencyRates') return { getAccountingUsdRub: async () => null };
    if (name === '@logtail/node') return { Logtail: class { constructor() { throw new Error('No live logger'); } } };
    if (name.startsWith('@/')) return load(join('src', name.slice(2) + '.ts'));
    if (name.startsWith('.')) {
      const target = resolve(dirname(file), name);
      if (target.endsWith('.json')) return JSON.parse(readFileSync(target, 'utf8'));
      return load(existsSync(target + '.ts') ? target + '.ts' : target + '.js');
    }
    return require(name);
  };
  new Function('require','module','exports','process','fetch','console',code)(dependency,mod,mod.exports,
    { env: testEnv }, providerFetch, fakeConsole);
  return mod.exports;
}
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`PASS ${label}`); };
const bodyFor = (extra = {}) => ({ name: 'Fixture', avatarPrompt: marker, scope: 'create:character', clientKey: randomUUID(), ...extra });
const post = body => new NextRequest('https://example.test/api/generate-avatar', { method: 'POST', body: JSON.stringify(body) });
const get = params => new NextRequest('https://example.test/api/generate-avatar?' + new URLSearchParams(params));
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('nv_kie_test'); await ddl.connect();
  const schema = join(directory, 'schema.prisma');
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace('Unsupported("vector(1536)")', 'Bytes'));
  const setup = spawnSync(process.execPath, ['node_modules/prisma/build/index.js','db','push','--skip-generate','--schema',schema],
    { env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  assert.equal(setup.status, 0, 'private schema setup: ' + setup.stderr);
  const user = await db.user.create({ data: { email: 'kie@example.test', subscriptionType: 'dialog', subscriptionEnd: new Date(Date.now() + 86400000), lastTokenMonth: new Date() } });
  userId = user.id;
  const input = load('src/lib/avatarRequest.ts');
  await assert.rejects(input.readAvatarBody(new Request('https://example.test', { method: 'POST',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(11)); controller.close(); } }), duplex: 'half' }), 10), input.AvatarBodyTooLarge);
  check(true, 'chunked requests respect actual byte limit without Content-Length');
  const legacy = await db.avatarQuotaReservation.create({ data: { id: randomUUID(), userId, units: 1, month: new Date(), status: 'completed' } });
  await ddl.query('DROP TABLE "AvatarGeneration"');
  await ddl.query('BEGIN');
  await ddl.query(readFileSync('prisma/migrations/20261011190000_kie_avatar_jobs/migration.sql','utf8'));
  await ddl.query('COMMIT');
  check(!!await db.avatarQuotaReservation.findUnique({ where: { id: legacy.id } }), 'scoped SQL preserves legacy quota reservations');
  const handler = load('src/app/api/generate-avatar/route.ts'), jobs = load('src/lib/kieAvatarJobs.ts');
  const kie = load('src/lib/kieAi.ts'), telemetry = load('src/lib/aiCostTelemetry.ts');
  userId = null;
  check((await handler.POST(post(bodyFor()))).status === 401 && creates === 0, 'authentication before paid call');
  userId = user.id;
  for (const ref of ['http://127.0.0.1/a', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AAAA']) {
    check((await handler.POST(post(bodyFor({ referenceImage: ref })))).status === 400 && creates === 0,
      'invalid URL/raster rejected before quota and paid calls');
  }
  const request = bodyFor({ modelId: 'malicious/expensive', resolution: '4K', num_images: 9 });
  const initial = await handler.POST(post(request)); const initialBody = await initial.json();
  check(initial.status === 202 && initialBody.state === 'pending' && initialBody.tokenStatus.monthlyRemaining === 8, 'one quota unit reserved for asynchronous task');
  check(requests[0].model === 'seedream/5-flash-text-to-image' && requests[0].input.size === '1K'
    && !('num_images' in requests[0].input), 'text routing ignores client model/resolution/count');
  check(requests[0].callBackUrl === 'https://example.test/api/webhook/kie', 'callback URL comes from server configuration');
  const finished = await handler.GET(get({ jobId: initialBody.jobId })); const completed = await finished.json();
  check(completed.state === 'succeeded' && completed.imageUrl.startsWith('data:image/webp;base64,'), 'result validated, converted and persisted beyond temporary URL');
  const replay = await handler.POST(post(request));
  check((await replay.json()).jobId === initialBody.jobId && creates === 1, 'same request replays without another paid task');
  check((await handler.POST(post({ ...request, avatarPrompt: 'changed' }))).status === 409, 'changed payload cannot reuse an idempotency key');
  const measured = await db.aiCostEvent.findUnique({ where: { id: initialBody.jobId } });
  check(measured.provider === 'kie' && measured.providerCostNative === 4 && measured.estimatedCostRub === 2
    && measured.reportedCostRub === null && measured.providerRequestId === 'fixture_task_1', 'credits, estimate and provider task linked to one cost record');
  const oldJob = { ...(await db.avatarGeneration.findUnique({ where: { id: initialBody.jobId } })), state: 'pending', credits: null };
  await telemetry.recordKieAvatarCost(oldJob);
  check((await db.aiCostEvent.findUnique({ where: { id: initialBody.jobId } })).outcome === 'completed', 'stale pending cost writer cannot erase completion');
  check(buildAiCostReport([measured]).coverage.estimatedCost === 1 && buildAiCostReport([measured]).coverage.confirmedCost === 0,
    'economy report treats credit conversion as estimate');
  userId = (await db.user.create({ data: { email: 'other@example.test' } })).id;
  check((await handler.GET(get({ jobId: initialBody.jobId }))).status === 404, 'another account cannot read image or provider task');
  userId = user.id;
  const refStart = await handler.POST(post(bodyFor({ referenceImage: reference })));
  const refBody = await refStart.json();
  check(uploads === 1 && requests.at(-1).model === 'nano-banana-2-1' && requests.at(-1).input.resolution === '1K'
    && requests.at(-1).input.image_input.length === 1, 'reference is uploaded and automatically routed to Nano Banana 2.1');
  downloadFails = true;
  check((await (await handler.GET(get({ jobId: refBody.jobId }))).json()).state === 'pending', 'image download failure keeps paid task for retry');
  check((await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 2, 'download failure does not refund successful billed generation');
  downloadFails = false;
  await db.avatarGeneration.update({ where: { id: refBody.jobId }, data: { nextPollAt: new Date(0) } });
  const callback = load('src/app/api/webhook/kie/route.ts');
  const taskId = (await db.avatarGeneration.findUnique({ where: { id: refBody.jobId } })).providerTaskId;
  const timestamp = String(Math.floor(Date.now()/1000));
  const signature = createHmac('sha256',testEnv.KIE_WEBHOOK_HMAC_KEY).update(`${taskId}.${timestamp}`).digest('base64');
  const cbRequest = sig => new NextRequest('https://example.test/api/webhook/kie', { method: 'POST',
    headers: { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': sig },
    body: JSON.stringify({ data: { taskId, state: 'fail', resultJson: marker } }) });
  check((await callback.POST(cbRequest('bad'))).status === 401, 'unsigned callback rejected');
  check((await callback.POST(cbRequest(signature))).status === 200
    && (await db.avatarGeneration.findUnique({ where: { id: refBody.jobId } })).state === 'succeeded', 'signed callback re-fetches authoritative status, ignores forged body state');
  check(!kie.verifyKieWebhook(taskId,String(Number(timestamp)-301),signature)
    && !kie.verifyKieWebhook(taskId,timestamp,'ж'.repeat(44)), 'old/non-ASCII signatures fail safely');
  for (const value of ['http://tempfile.aiquickdraw.com/a','https://127.0.0.1/a','https://aiquickdraw.com.evil.test/a','https://user:pass@tempfile.aiquickdraw.com/a','https://tempfile.aiquickdraw.com:444/a']) {
    check(!kie.isKieImageUrl(value), 'result URLs exclude private/untrusted/credentialed origins');
  }
  state = 'waiting';
  const before = creates;
  const parallel = await Promise.all([handler.POST(post(bodyFor())), handler.POST(post(bodyFor()))]);
  const parallelBodies = await Promise.all(parallel.map(r => r.json()));
  check(creates === before + 1 && parallelBodies[0].jobId === parallelBodies[1].jobId, 'concurrent tabs create one task and reserve one unit');
  const active = await db.avatarGeneration.findUnique({ where: { id: parallelBodies[0].jobId } });
  await db.avatarGeneration.update({ where: { id: active.id }, data: { leaseToken: 'lease_a', leaseUntil: new Date(Date.now()+60000) } });
  await jobs.finishAvatarJob(active,'failed',{},'lease_b');
  check((await db.avatarGeneration.findUnique({ where: { id: active.id } })).state === 'pending', 'stale worker cannot finish another lease');
  await db.avatarGeneration.update({ where: { id: active.id }, data: { leaseToken: null, leaseUntil: null, nextPollAt: new Date(0) } });
  state = 'fail';
  await handler.GET(get({ jobId: active.id })); await handler.GET(get({ jobId: active.id }));
  check((await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 2, 'terminal provider failure refunds exactly once');
  createMode = 'reject';
  const rejection = await handler.POST(post(bodyFor()));
  check((await rejection.json()).state === 'failed' && (await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 2,
    'explicit create rejection refunds; provider text never returned');
  createMode = 'lost';
  const lostBody = await (await handler.POST(post(bodyFor()))).json();
  check(lostBody.state === 'uncertain' && (await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 3,
    'lost create response retains quota for review');
  const beforeLost = creates;
  await handler.POST(post(bodyFor()));
  check(creates === beforeLost, 'uncertain task blocks automatic duplicate paid calls');
  // Fixture owner resolves the ambiguous run; no production equivalent is called here.
  const lost = await db.avatarGeneration.findUnique({ where: { id: lostBody.jobId } });
  await jobs.finishAvatarJob(lost,'failed'); createMode = 'ok'; state = 'fail';
  createMode = 'malformed';
  const malformed = await (await handler.POST(post(bodyFor()))).json();
  check(malformed.state === 'uncertain', '200 response without task ID is uncertain, not refundable success');
  await jobs.finishAvatarJob(await db.avatarGeneration.findUnique({ where: { id: malformed.jobId } }),'failed');
  createMode = 'ok';
  const tokens = load('src/lib/avatarTokens.ts');
  const staleReservation = await tokens.reserveAvatarGeneration(user.id, { clientKey: randomUUID(), scope: 'create:character',
    payloadHash: 'fixture', model: 'seedream/5-flash-text-to-image', estimatedCredits: 3.24, creditRub: 0.5 });
  await db.avatarGeneration.update({ where: { id: staleReservation.generation.id }, data: { leaseUntil: new Date(0) } });
  check((await jobs.reconcileAvatarJob(staleReservation.generation.id)).state === 'uncertain', 'process crash during creation becomes review, never a new paid submission');
  await jobs.finishAvatarJob(await db.avatarGeneration.findUnique({ where: { id: staleReservation.generation.id } }),'failed');
  const rollover = await (await handler.POST(post(bodyFor()))).json();
  await db.user.update({ where: { id: user.id }, data: { tokensUsedThisMonth: 0, lastTokenMonth: new Date(Date.now()+86400000) } });
  await handler.GET(get({ jobId: rollover.jobId }));
  check((await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 0, 'old-period failure cannot subtract new-period quota');
  await db.user.update({ where: { id: user.id }, data: { tokensUsedThisMonth: 9, lastTokenMonth: new Date() } });
  const beforeLimit = creates;
  check((await handler.POST(post(bodyFor()))).status === 402 && creates === beforeLimit, 'exhausted quota rejected before paid calls');
  const cron = load('src/app/api/cron/reconcile-avatars/route.ts');
  check((await cron.GET(new NextRequest('https://example.test/api/cron/reconcile-avatars'))).status === 401, 'recovery cron requires secret');
  check((await cron.GET(new NextRequest('https://example.test/api/cron/reconcile-avatars', { headers: { Authorization: `Bearer ${testEnv.CRON_SECRET}` } }))).status === 200,
    'authenticated recovery cron runs without browser');
  check(!logs.join('\n').includes(marker) && !logs.join('\n').includes(testEnv.KIE_API_KEY), 'logs omit prompt, provider text and API key');
  console.log(`Kie avatar verification: ${checks} passed. No paid requests or production DB access.`);
} finally {
  await db.$disconnect(); await ddl.end();
  if (process.platform === 'win32' && pg.process) {
    const child = pg.process;
    assert.equal(resolve(child.spawnargs[child.spawnargs.indexOf('-D')+1]), resolve(join(directory,'db')));
    const closed = new Promise(done => child.once('close',done));
    const stop = spawnSync(join(dirname(child.spawnfile),'pg_ctl.exe'), ['stop','-D',join(directory,'db'),'-m','fast','-w','-t','15'],
      { encoding:'utf8', windowsHide:true, timeout:20000 });
    assert.equal(stop.status,0); await closed; pg.process = undefined;
  } else await pg.stop();
}
