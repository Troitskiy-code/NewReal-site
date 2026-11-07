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
const testEnv = { DEEPINFRA_API_KEY: 'synthetic_deepinfra_key', CHAT_THREADS_ENABLED: 'true', KIE_API_KEY: 'synthetic_fixture_key', KIE_WEBHOOK_HMAC_KEY: 'synthetic_fixture_hmac',
  NEXTAUTH_URL: 'https://example.test', NEXTAUTH_SECRET: 'synthetic_fixture_actor', CRON_SECRET: 'synthetic_fixture_cron',
  S3_ENDPOINT: 'https://storage.yandexcloud.net', S3_REGION: 'ru-central1', S3_BUCKET: 'fixture',
  S3_ACCESS_KEY_ID: 'synthetic_fixture_key', S3_SECRET_ACCESS_KEY: 'synthetic_fixture_secret' };
const storedImages = new Map();
const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#789abc' } }).png().toBuffer();
const reference = `data:image/png;base64,${png.toString('base64')}`;
const marker = 'SYNTHETIC_PRIVATE_PROMPT';
const logs = [];
const fakeConsole = Object.fromEntries(['log','info','warn','error','debug'].map(name => [name, (...args) => logs.push(args.map(String).join(' '))]));
let userId, creates = 0, uploads = 0, state = 'success', createMode = 'ok', downloadFails = false, refuseNext = 0, paramMode = 'ok', moderateNext = 0;
const tasks = new Map();
const requests = [];
const json = (value, status = 200) => Response.json(value, { status });
async function providerFetch(url, init = {}) {
  const parsed = new URL(url);
  if (parsed.host === 'kieai.redpandaai.co' && parsed.pathname === '/api/file-base64-upload') {
    uploads++; const body = JSON.parse(init.body);
    assert.ok(body.base64Data.startsWith('data:image/webp;base64,') && body.fileName.endsWith('.webp'));
    return json({ code: 200, data: { downloadUrl: `https://tempfile.redpandaai.co/${body.fileName}` } });
  }
  if (parsed.host === 'api.kie.ai' && parsed.pathname === '/api/v1/jobs/createTask') {
    creates++; const body = JSON.parse(init.body); requests.push(body);
    assert.equal(init.redirect, 'error');
    if (createMode === 'lost') throw new Error(marker);
    if (createMode === 'reject') return json({ code: 402, msg: marker });
    // Kie answers HTTP 200 with a failure code in the body when moderation refuses the input.
    if (createMode === 'moderated') return json({ code: 501, msg: 'Content flagged as sensitive' });
    if (moderateNext > 0) { moderateNext--; return json({ code: 501, msg: 'Content flagged as sensitive' }); }
    if (createMode === 'malformed') return json({ code: 200, msg: marker });
    const taskId = `fixture_task_${creates}`;
    const refused = refuseNext > 0;
    if (refused) refuseNext--;
    tasks.set(taskId, { model: body.model, input: body.input, refused }); return json({ code: 200, data: { taskId } });
  }
  if (parsed.host === 'api.kie.ai' && parsed.pathname === '/api/v1/jobs/recordInfo') {
    const taskId = parsed.searchParams.get('taskId');
    const task = tasks.get(taskId);
    // Kie's real record for a filter refusal: failCode 400, credits 0, the request as nested JSON strings.
    if (task.refused) return json({ code: 200, data: { taskId, model: task.model, state: 'fail', creditsConsumed: 0, failCode: '400',
      failMsg: 'The input or output was flagged as sensitive. Please try again with different inputs.',
      param: paramMode === 'missing' ? '' : JSON.stringify({ model: task.model, input: JSON.stringify(task.input) }) } });
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
// Prompt-writer model stub: the avatar route never reaches a real text provider in this suite.
let writerMode = 'ok';
const writerCalls = [];
const WRITTEN_SCENE = 'A weathered innkeeper in a linen apron stands by a stone hearth, warm firelight on her face, dried herbs hanging from dark wooden beams, a calm and welcoming expression.';
let rewriteMode = 'ok', rewriteIntimateOnce = 0;
const rewriteCalls = [];
const REWRITTEN_PROMPT = 'A calm portrait of the same person in a wool coat at a quiet window, in soft daylight, with a relaxed expression and no text in the frame.';
const CLOTHED_REWRITE = `${REWRITTEN_PROMPT} Every person is fully dressed in ordinary everyday clothes that cover the torso and legs.`;
const BEDROOM_SCENE = 'Ada sits beside the turquoise bedspread and looks up with a calm smile in the warm light of an amber lamp, with rain on the round window.';
let sceneWardrobe = 'ordinary';
async function writerStub(purpose, url, body) {
  if (purpose === 'story_scene_prompt') {
    writerCalls.push({ purpose, body });
    const content = writerMode === 'garbage' ? 'not json at all'
      : '```json\n' + JSON.stringify({ description: sceneWardrobe === 'adult_underwear' ? BEDROOM_SCENE : WRITTEN_SCENE, wardrobe: sceneWardrobe }) + '\n```';
    return { status: 200, headers: {}, data: { choices: [{ finish_reason: 'stop', message: { content } }] } };
  }
  if (body.messages[0].content.includes('content filter refused')) {
    rewriteCalls.push({ purpose, body });
    if (rewriteMode === 'timeout') throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    if (rewriteMode === 'underwear') return { data: { choices: [{ message: { content: JSON.stringify({ prompt: 'A calm portrait of the 34-year-old woman in black lace lingerie on a sofa, in soft evening light, with a relaxed expression and no text in the frame.' }) } }] } };
    if (rewriteMode === 'nudity') return { data: { choices: [{ message: { content: JSON.stringify({ prompt: 'A calm portrait of the 34-year-old woman, naked on a sofa, in soft evening light, with a relaxed expression and no text in the frame.' }) } }] } };
    if (rewriteMode === 'intimate' || rewriteIntimateOnce > 0) {
      if (rewriteIntimateOnce > 0) rewriteIntimateOnce--;
      return { data: { choices: [{ message: { content: JSON.stringify({ prompt: 'The same person stays in a hot bathtub at night, with soft candles around her and a relaxed expression, and no text in the frame.' }) } }] } };
    }
    return { data: { choices: [{ message: { content: rewriteMode === 'refusal' ? JSON.stringify({ prompt: "I'm sorry, but I can't help with this request because it goes against the rules of this service." }) : JSON.stringify({ prompt: REWRITTEN_PROMPT }) } }] } };
  }
  writerCalls.push({ purpose, body });
  if (writerMode === 'timeout') throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
  const content = writerMode === 'garbage' ? 'not json at all'
    : writerMode === 'refusal' ? JSON.stringify({ description: "I'm sorry, but I can't help with this request because it goes against the content rules of this service." })
    : '```json\n' + JSON.stringify({ description: WRITTEN_SCENE }) + '\n```';
  return { data: { choices: [{ message: { content } }] } };
}
const cache = new Map();
function load(file) {
  file = resolve(file); if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} }; cache.set(file, mod.exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const dependency = name => {
    if (name === '@aws-sdk/client-s3') return {
      PutObjectCommand: class { constructor(input) { this.input = input; } },
      GetObjectCommand: class { constructor(input) { this.input = input; } },
      S3Client: class {
        async send({ input: { Key, Body } }) {
          if (Body) { storedImages.set(Key, Body); return; }
          const image = storedImages.get(Key);
          if (!image) throw Object.assign(new Error('Missing fixture image'), { $metadata: { httpStatusCode: 404 } });
          return { ContentLength: image.byteLength, Body: { transformToByteArray: async () => image } };
        }
        destroy() {}
      },
    };
    if (name === 'axios') return { post: (url, body) => writerStub('story_scene_prompt', url, body), isAxiosError: () => false };
    if (name === '@/lib/prisma' || name === './prisma') return { prisma: db };
    if (name === '@/lib/auth') return { authOptions: {} };
    if (name === 'next-auth/next') return { getServerSession: async () => userId ? { user: { id: userId } } : null };
    if (name === './currencyRates') return { getAccountingUsdRub: async () => null };
    if (name === '@logtail/node') return { Logtail: class { constructor() { throw new Error('No live logger'); } } };
    if (name === './aiTextClient' || name === '@/lib/aiTextClient') return { serviceChatPost: writerStub };
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
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace(/Unsupported\("vector\(\d+\)"\)/g, 'Bytes'));
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
  await ddl.query('ALTER TABLE "ChatThread" DROP COLUMN "sceneAvatarJobId"');
  await ddl.query('DROP TABLE "AvatarGeneration"');
  await ddl.query('BEGIN');
  await ddl.query(readFileSync('prisma/migrations/20261011190000_kie_avatar_jobs/migration.sql','utf8'));
  await ddl.query('COMMIT');
  await ddl.query(readFileSync('prisma/migrations/20261107160000_story_scene_avatar/migration.sql', 'utf8'));
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
  check(requests[0].model === 'seedream/5-lite-text-to-image' && requests[0].input.quality === 'basic'
    && !('num_images' in requests[0].input), 'text routing ignores client model/resolution/count');
  check(requests[0].callBackUrl === 'https://example.test/api/webhook/kie', 'callback URL comes from server configuration');
  const finished = await handler.GET(get({ jobId: initialBody.jobId })); const completed = await finished.json();
  check(completed.state === 'succeeded' && completed.imageUrl.startsWith('/api/character-media/')
    && storedImages.size === 1 && (await sharp([...storedImages.values()][0]).metadata()).format === 'webp',
    'generated result persisted as WebP in object storage; DB contains a stable app reference');
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
  check(uploads === 1 && requests.at(-1).model === 'seedream/5-lite-image-to-image' && requests.at(-1).input.quality === 'basic'
    && requests.at(-1).input.image_urls.length === 1, 'reference is uploaded and automatically routed to Seedream 5.0 Lite');
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
  createMode = 'moderated';
  const moderated = await (await handler.POST(post(bodyFor()))).json();
  check(moderated.state === 'failed' && moderated.error?.includes('правилами') && !moderated.blocked
    && (await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 2,
    'moderation refusal in a 200 body fails and refunds instead of blocking as uncertain');
  createMode = 'lost';
  const lostBody = await (await handler.POST(post(bodyFor()))).json();
  check(lostBody.state === 'uncertain' && (await db.user.findUnique({ where: { id: user.id } })).tokensUsedThisMonth === 3,
    'lost create response retains quota for review');
  const beforeLost = creates;
  await handler.POST(post(bodyFor()));
  check(creates === beforeLost && lostBody.blocked === true, 'uncertain task blocks automatic duplicate paid calls');
  check(lostBody.retryAfterSeconds > 0 && lostBody.retryAfterSeconds <= 300 && /через \d+ мин/.test(lostBody.error), 'blocked run tells how long the 5-minute window still lasts');
  // After the window the user can generate again; the uncertain run keeps its quota for review.
  await db.avatarGeneration.update({ where: { id: lostBody.jobId }, data: { updatedAt: new Date(Date.now() - 16 * 60_000) } });
  check((await (await handler.GET(get({ jobId: lostBody.jobId }))).json()).blocked === false, 'expired uncertain run reports it no longer blocks');
  createMode = 'ok';
  const beforeExpired = creates;
  const afterWindow = await (await handler.POST(post(bodyFor()))).json();
  check(creates === beforeExpired + 1 && afterWindow.jobId !== lostBody.jobId, 'expired uncertain window allows a new paid run');
  await jobs.finishAvatarJob(await db.avatarGeneration.findUnique({ where: { id: afterWindow.jobId } }), 'failed');
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
    payloadHash: 'fixture', model: 'seedream/5-lite-text-to-image', estimatedCredits: 5.5, creditRub: 0.5 });
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
  // Prompt writer (AVATAR_PROMPT_LLM_ENABLED) on a fresh user, so earlier quota and job state do not interfere.
  userId = (await db.user.create({ data: { email: 'writer@example.test', subscriptionType: 'dialog',
    subscriptionEnd: new Date(Date.now() + 86400000), lastTokenMonth: new Date() } })).id;
  const finishJob = async body => jobs.finishAvatarJob(await db.avatarGeneration.findUnique({ where: { id: body.jobId } }), 'failed');
  const writerRun = async (mode, extra = {}) => {
    writerMode = mode; const before = requests.length;
    const body = await (await handler.POST(post(bodyFor({ name: 'Лира', appearance: 'тёмная коса', ...extra })))).json();
    const prompt = requests.length > before ? requests.at(-1).input.prompt : null;
    await finishJob(body);
    return prompt;
  };
  const templateOnly = await writerRun('ok');
  check(writerCalls.length === 0 && templateOnly.includes('Requested details'), 'writer stays off by default; the template is used');
  testEnv.AVATAR_PROMPT_LLM_ENABLED = 'true';
  const groupPrompt = await writerRun('ok', { roleplayMode: 'group', rpConfig: { participants: [
    { id: 'a', name: 'Учёный', appearance: 'очки', description: '' }, { id: 'b', name: 'Проводник', appearance: 'шрам на щеке', description: '' }] } });
  check(writerCalls.at(-1).purpose === 'avatar_prompt' && groupPrompt.includes('weathered innkeeper')
    && groupPrompt.includes('natural human scale') && groupPrompt.endsWith('logos, watermarks or frames.'),
    'written scene is wrapped in code-owned composition and no-text rules');
  const sentCard = JSON.parse(writerCalls.at(-1).body.messages[1].content);
  check(sentCard.characters?.length === 2 && sentCard.characters[1].appearance === 'шрам на щеке' && sentCard.user_wishes === marker,
    'writer receives every group member and the image wishes');
  await writerRun('ok', { referenceImage: reference });
  check(!JSON.stringify(writerCalls.at(-1).body).includes('base64') && writerCalls.at(-1).body.messages[0].content.includes('Never mention gender, age, face')
    && !('appearance' in JSON.parse(writerCalls.at(-1).body.messages[1].content)),
    'reference image is never sent to the writer, which leaves the face to the reference');
  for (const mode of ['timeout', 'garbage', 'refusal']) {
    const fallback = await writerRun(mode);
    check(fallback?.includes('Appearance: тёмная коса.') && !fallback.includes('weathered innkeeper'), `writer ${mode} falls back to the template`);
  }
  writerMode = 'ok';
  const retried = bodyFor({ name: 'Лира' });
  const firstRun = await (await handler.POST(post(retried))).json();
  const writerCallsAfterFirst = writerCalls.length;
  const secondRun = await (await handler.POST(post(retried))).json();
  check(secondRun.jobId === firstRun.jobId && writerCalls.length === writerCallsAfterFirst, 'a retried request reuses its job and never calls the writer twice');
  await finishJob(firstRun);
  delete testEnv.AVATAR_PROMPT_LLM_ENABLED;

  // A filter refusal is replaced by a milder prompt instead of reaching the user.
  userId = (await db.user.create({ data: { email: 'rewrite@example.test', subscriptionType: 'dialog',
    subscriptionEnd: new Date(Date.now() + 86400000), lastTokenMonth: new Date() } })).id;
  const rewriteUser = userId;
  state = 'success';
  const used = async () => (await db.user.findUnique({ where: { id: rewriteUser } })).tokensUsedThisMonth;
  const job = id => db.avatarGeneration.findUnique({ where: { id } });
  const poll = async id => {
    await db.avatarGeneration.update({ where: { id }, data: { nextPollAt: new Date(0) } });
    return (await handler.GET(get({ jobId: id }))).json();
  };
  refuseNext = 1;
  const refusedOnce = await (await handler.POST(post(bodyFor({ referenceImage: reference })))).json();
  const refusedInput = requests.at(-1).input;
  const firstTask = (await job(refusedOnce.jobId)).providerTaskId;
  const afterRefusal = await poll(refusedOnce.jobId);
  check(afterRefusal.state === 'pending' && (await job(refusedOnce.jobId)).providerTaskId !== firstTask
    && (await job(refusedOnce.jobId)).errorCode === 'safety_rewrite_1' && !afterRefusal.error, 'a refused task is replaced and the user keeps waiting without an error');
  check(requests.at(-1).input.prompt === CLOTHED_REWRITE && requests.at(-1).input.image_urls[0] === refusedInput.image_urls[0]
    && requests.at(-1).model === 'seedream/5-lite-image-to-image', 'the retry sends the rewritten prompt with the same reference and model');
  check(rewriteCalls.at(-1).body.messages[1].content.includes(refusedInput.prompt.slice(0, 40)), "the rewrite starts from Kie's record of the refused prompt");
  check(requests.at(-1).input.prompt.endsWith('that cover the torso and legs.'), 'the code itself dresses everyone in the rewritten prompt');
  const rewrittenDone = await poll(refusedOnce.jobId);
  const rewrittenCost = await db.aiCostEvent.findUnique({ where: { id: refusedOnce.jobId } });
  check(rewrittenDone.state === 'succeeded' && await used() === 1 && rewrittenCost.providerRequestId === (await job(refusedOnce.jobId)).providerTaskId,
    'the rewritten result completes on one quota unit and costs are linked to the final task');
  await poll(refusedOnce.jobId);
  check(await used() === 1, 'repeated polling cannot charge or retry a finished rewrite');

  refuseNext = 1;
  const noReference = await (await handler.POST(post(bodyFor()))).json();
  await poll(noReference.jobId);
  const firstRules = rewriteCalls.at(-1).body.messages[0].content;
  check(firstRules.includes('fully dressed') && firstRules.includes('Never add an age') && firstRules.includes('Never use euphemisms')
    && !firstRules.includes('leave out any closeness'), 'the first rewrite dresses everyone without inventing an age or hiding details');
  await poll(noReference.jobId);

  refuseNext = 4;
  const beforeRefusals = creates;
  const alwaysRefused = await (await handler.POST(post(bodyFor()))).json();
  await poll(alwaysRefused.jobId);
  const secondRules = rewriteCalls.length;
  await poll(alwaysRefused.jobId);
  check(rewriteCalls.length === secondRules + 1 && rewriteCalls.at(-1).body.messages[0].content.includes('leave out any closeness'), 'the second rewrite is stricter');
  await poll(alwaysRefused.jobId);
  const refusedFinal = await poll(alwaysRefused.jobId);
  check(refusedFinal.state === 'failed' && refusedFinal.error?.includes('правилами') && creates === beforeRefusals + 4
    && await used() === 2, 'after three rewrites the refusal reaches the user and the generation is refunded');

  refuseNext = 1; rewriteIntimateOnce = 1;
  const beforeIntimate = rewriteCalls.length;
  const intimateOnce = await (await handler.POST(post(bodyFor()))).json();
  await poll(intimateOnce.jobId);
  check(rewriteCalls.length === beforeIntimate + 2 && requests.at(-1).input.prompt === CLOTHED_REWRITE, 'an answer that keeps an intimate detail is rejected and asked again');
  await poll(intimateOnce.jobId);
  const usedAfterIntimateOnce = await used();
  refuseNext = 1; rewriteMode = 'intimate';
  const beforeStubborn = creates;
  const stubborn = await (await handler.POST(post(bodyFor()))).json();
  const stubbornEnd = await poll(stubborn.jobId);
  check(stubbornEnd.state === 'failed' && creates === beforeStubborn + 1 && await used() === usedAfterIntimateOnce, 'an intimate prompt is never sent to the image model, the generation is refunded');
  const baseUsed = await used();
  refuseNext = 1; rewriteMode = 'refusal';
  const modelRefused = await (await handler.POST(post(bodyFor()))).json();
  const refusedByModel = await poll(modelRefused.jobId);
  check(refusedByModel.state === 'failed' && await used() === baseUsed, 'an unusable rewrite refunds instead of resending the prompt');
  refuseNext = 1; rewriteMode = 'timeout';
  const timedOut = await (await handler.POST(post(bodyFor()))).json();
  check((await poll(timedOut.jobId)).state === 'failed' && await used() === baseUsed, 'a rewrite timeout refunds');
  rewriteMode = 'ok';

  refuseNext = 1; paramMode = 'missing';
  const noRecord = await (await handler.POST(post(bodyFor()))).json();
  const callsBeforeNoRecord = rewriteCalls.length;
  check((await poll(noRecord.jobId)).state === 'failed' && rewriteCalls.length === callsBeforeNoRecord && await used() === baseUsed, 'without a provider record nothing is rewritten and the generation is refunded');
  paramMode = 'ok';

  testEnv.AVATAR_SAFETY_REWRITE_ENABLED = 'false';
  refuseNext = 1;
  const disabled = await (await handler.POST(post(bodyFor()))).json();
  const callsBeforeDisabled = rewriteCalls.length;
  check((await poll(disabled.jobId)).state === 'failed' && rewriteCalls.length === callsBeforeDisabled, 'the flag turns rewriting off');
  delete testEnv.AVATAR_SAFETY_REWRITE_ENABLED;

  refuseNext = 1;
  const lostRetry = await (await handler.POST(post(bodyFor()))).json();
  createMode = 'lost';
  const lostRetryResult = await poll(lostRetry.jobId);
  check(lostRetryResult.state === 'uncertain' && lostRetryResult.blocked === true && await used() === baseUsed + 1, 'a lost response on the retry goes to review, never a new paid submission');
  createMode = 'ok';
  await jobs.finishAvatarJob(await job(lostRetry.jobId), 'failed');

  moderateNext = 1;
  const beforeSync = rewriteCalls.length;
  const syncRefused = await (await handler.POST(post(bodyFor()))).json();
  check(syncRefused.state === 'pending' && rewriteCalls.length === beforeSync + 1 && requests.at(-1).input.prompt === CLOTHED_REWRITE
    && (await job(syncRefused.jobId)).errorCode === 'safety_rewrite_1', 'a refusal at creation is rewritten inside the same request');
  await poll(syncRefused.jobId);

  // Underwear stays only when the code itself sees adult ages. Age fixtures stay neutral on purpose.
  const rewrite = load('src/lib/avatarPromptRewrite.ts');
  check(rewrite.statesOnlyAdultAges('A 34-year-old woman stands by a window.') && rewrite.statesOnlyAdultAges('Женщина 30 лет у окна.')
    && rewrite.statesOnlyAdultAges('Lira, 32 years old, and Kai, aged 40.'), 'adult ages are recognized in English and Russian');
  check(!rewrite.statesOnlyAdultAges('A woman stands by a window.') && !rewrite.statesOnlyAdultAges('A 16-year-old student at a desk.')
    && !rewrite.statesOnlyAdultAges('A 30-year-old and a 15 year old at a table.') && !rewrite.statesOnlyAdultAges('A young woman, 25 years old.')
    && !rewrite.statesOnlyAdultAges('Девушка 20 лет у окна.'), 'a missing age, any age under 18 or a youth word fails the check');
  const ADULT_LINGERIE = 'Anime illustration. The woman is 34 years old, in black lingerie on a sofa, in soft evening light, with no text in the frame.';
  const systemOf = () => rewriteCalls.at(-1).body.messages[0].content;
  rewriteMode = 'underwear';
  const kept = await rewrite.rewriteRefusedAvatarPrompt(ADULT_LINGERIE, 1, false);
  check(systemOf().includes('Everyone wears underwear') && kept.includes('keeps their underwear on') && kept.includes('clearly an adult'),
    'verified adult ages keep underwear, and the code adds the underwear and adult sentences');
  const beforeModes = rewriteCalls.length;
  rewriteMode = 'ok';
  const withReferenceRewrite = await rewrite.rewriteRefusedAvatarPrompt(ADULT_LINGERIE, 1, true);
  check(rewriteCalls.length === beforeModes + 1 && systemOf().includes('fully dressed') && withReferenceRewrite === CLOTHED_REWRITE, 'an uploaded photo is always dressed');
  await rewrite.rewriteRefusedAvatarPrompt('Anime illustration. A woman in black lingerie on a sofa, in soft evening light, with no text in the frame.', 1, false);
  check(systemOf().includes('fully dressed'), 'without a stated age the rewrite dresses the person');
  await rewrite.rewriteRefusedAvatarPrompt(ADULT_LINGERIE, 2, false);
  check(systemOf().includes('plain cotton underwear'), 'the second rewrite gives verified adults a calmer underwear scene');
  await rewrite.rewriteRefusedAvatarPrompt(ADULT_LINGERIE, 3, false);
  check(systemOf().includes('leave out any closeness'), 'the last rewrite always dresses and removes closeness');
  await rewrite.rewriteRefusedAvatarPrompt(`${ADULT_LINGERIE} Every person keeps their underwear on, and it covers the chest and hips. Every person shown is clearly an adult, with a mature face and adult proportions.`, 2, false);
  check(!rewriteCalls.at(-1).body.messages[1].content.includes('keeps their underwear on'), 'a later rewrite does not inherit the code-owned sentences');
  rewriteMode = 'nudity';
  const beforeNudity = rewriteCalls.length;
  const afterNudity = await rewrite.rewriteRefusedAvatarPrompt(ADULT_LINGERIE, 1, false);
  check(rewriteCalls.length === beforeNudity + 2 && afterNudity === null, 'an answer describing nudity is rejected, then the clothed rule is tried');
  rewriteMode = 'ok';

  // Story scenes on the monthly generation allowance.
  const sceneOwner = await db.user.create({ data: { email: 'scene@example.test', subscriptionType: 'dialog',
    subscriptionEnd: new Date(Date.now() + 86400000), lastTokenMonth: new Date() } });
  userId = sceneOwner.id;
  state = 'success';
  const card = await db.character.create({ data: { name: 'Scene fixture', userId, isPublic: true, artStyle: 'anime',
    appearance: 'A gray linen apron', totalMessages: 0 } });
  const thread = await db.chatThread.create({ data: { userId, characterId: card.id, number: 1 } });
  const otherThread = await db.chatThread.create({ data: { userId, characterId: card.id, number: 2 } });
  const createMessage = (threadId, content, createdAt, role = 'assistant') => db.message.create({ data: { userId,
    characterId: card.id, threadId, role, content, createdAt } });
  for (let i = 0; i < 9; i++) await createMessage(thread.id, `Old fixture turn ${i}`, new Date(Date.now() - (11 - i) * 1000));
  await createMessage(thread.id, "*Заходим в зал со старым камином.* 'Скрытая мысль о синей лодке.'", new Date());
  await createMessage(otherThread.id, 'Другая история. Подводная станция.', new Date());
  const sameOrigin = { 'sec-fetch-site': 'same-origin' };
  const scenePost = (body, headers = sameOrigin) => new NextRequest('https://example.test/api/generate-avatar',
    { method: 'POST', headers, body: JSON.stringify(body) });
  const sceneRequest = { scope: `story:${thread.id}`, clientKey: randomUUID() };
  const beforeScene = creates;
  check((await handler.POST(scenePost(sceneRequest, { 'sec-fetch-site': 'cross-site' }))).status === 403 && creates === beforeScene,
    'cross-site requests cannot start a story illustration');
  const sceneStarted = await (await handler.POST(scenePost(sceneRequest))).json();
  const sceneWritten = writerCalls.at(-1);
  const material = JSON.parse(sceneWritten.body.messages.at(-1).content);
  check(sceneStarted.state === 'pending' && sceneWritten.purpose === 'story_scene_prompt' && sceneWritten.body.model === 'google/gemma-4-31B-it-turbo'
    && material.chat.length === 8 && material.chat[0].text === 'Old fixture turn 2' && material.chat.at(-1).text.includes('камином')
    && !JSON.stringify(material).includes('лодке') && !JSON.stringify(material).includes('Подводная станция'),
    'Gemma sees only the newest eight messages from this story, with private thoughts removed');
  check(requests.at(-1).input.aspect_ratio === '1:1' && requests.at(-1).input.nsfw_checker
    && material.style === 'anime' && requests.at(-1).input.prompt.startsWith('Anime still')
    && requests.at(-1).input.prompt.includes(WRITTEN_SCENE) && !requests.at(-1).input.prompt.includes('камином'),
    'the image model receives a square request with the extracted description only');
  await createMessage(thread.id, 'Сцена изменилась после запуска.', new Date(Date.now() + 1000), 'user');
  const sceneReplay = await (await handler.POST(scenePost(sceneRequest))).json();
  check(sceneReplay.jobId === sceneStarted.jobId && creates === beforeScene + 1, 'retry after new messages returns the original paid job');
  check(sceneReplay.state === 'succeeded' && sceneReplay.imageUrl === `/api/story-scene-media/${thread.id}/${sceneReplay.jobId}`
    && storedImages.has(`story-scenes/${sceneOwner.id}/${thread.id}/${sceneReplay.jobId}.webp`)
    && !load('src/lib/characterMedia.ts').parseCharacterMediaPath(sceneReplay.imageUrl), 'scene image is private and outside the publishable character-media namespace');
  const sceneMedia = load('src/app/api/story-scene-media/[threadId]/[jobId]/route.ts');
  const settings = load('src/app/api/chat/[id]/threads/[threadId]/route.ts');
  const media = threadId => sceneMedia.GET(new Request('https://example.test' + sceneReplay.imageUrl),
    { params: Promise.resolve({ threadId, jobId: sceneReplay.jobId }) });
  const setAvatar = (threadId, id) => settings.PATCH(new NextRequest('https://example.test', { method: 'PATCH',
    headers: sameOrigin, body: JSON.stringify({ sceneAvatarJobId: id }) }), { params: Promise.resolve({ id: card.id, threadId }) });
  check((await media(thread.id)).headers.get('content-type') === 'image/webp' && (await media(otherThread.id)).status === 404
    && (await setAvatar(otherThread.id, sceneReplay.jobId)).status === 404, 'owner can read the image but another story cannot use it');
  check((await (await setAvatar(thread.id, sceneReplay.jobId)).json()).thread.sceneAvatarUrl === sceneReplay.imageUrl
    && (await db.chatThread.findUnique({ where: { id: thread.id } })).sceneAvatarJobId === sceneReplay.jobId
    && (await db.character.findUnique({ where: { id: card.id } })).imageUrl === null, 'assignment persists on this story alone');
  check((await (await setAvatar(thread.id, null)).json()).thread.sceneAvatarUrl === null, 'owner can restore the character avatar');
  userId = user.id;
  check((await media(thread.id)).status === 404 && (await setAvatar(thread.id, sceneReplay.jobId)).status === 404
    && (await handler.POST(scenePost({ ...sceneRequest, clientKey: randomUUID() }))).status === 404,
    'another account cannot generate, view or assign an illustration in this story');
  userId = sceneOwner.id;
  writerMode = 'garbage';
  const beforeInvalidScene = creates;
  const invalidScene = await (await handler.POST(scenePost({ ...sceneRequest, clientKey: randomUUID() }))).json();
  check(invalidScene.state === 'failed' && creates === beforeInvalidScene
    && (await db.user.findUnique({ where: { id: sceneOwner.id } })).tokensUsedThisMonth === 1,
    'an invalid scene description never reaches the image model and refunds its reservation');
  writerMode = 'ok';

  // Underwear in a scene: the code decides from the card, the avatar and the chat.
  const scenePrompt = async (threadId, wardrobe) => {
    sceneWardrobe = wardrobe;
    const before = requests.length;
    const body = await (await handler.POST(scenePost({ scope: `story:${threadId}`, clientKey: randomUUID() }))).json();
    if (body.jobId && !['failed', 'succeeded'].includes(body.state)) await poll(body.jobId);
    sceneWardrobe = 'ordinary';
    return { body, prompt: requests.length > before ? requests.at(-1).input.prompt : null };
  };
  const storyFor = async (data, line = 'Вечер в спальне отеля, тёплый свет лампы.') => {
    const created = await db.character.create({ data: { name: 'Gate fixture', userId, isPublic: true, artStyle: 'anime', totalMessages: 0, ...data } });
    const story = await db.chatThread.create({ data: { userId, characterId: created.id, number: 1 } });
    await db.message.create({ data: { userId, characterId: created.id, threadId: story.id, role: 'assistant', content: line, createdAt: new Date() } });
    return { created, story };
  };
  const noAge = await storyFor({ appearance: 'Silver hair' });
  check((await scenePrompt(noAge.story.id, 'adult_underwear')).prompt === null && writerCalls.at(-1).body.messages[0].content.includes('Underwear is not available'),
    'a card without a stated age never gets underwear, even when the writer asks for it');
  const dressed = await scenePrompt(noAge.story.id, 'ordinary');
  check(dressed.prompt.endsWith('No text, labels or watermark.') && dressed.prompt.includes('fully dressed'), 'the code dresses people when underwear is not allowed');
  const adultCard = await storyFor({ appearance: 'A woman, 34 years old, silver hair' });
  const allowed = await scenePrompt(adultCard.story.id, 'adult_underwear');
  check(allowed.prompt.includes('full-coverage underwear') && allowed.prompt.includes('clearly an adult') && !writerCalls.at(-1).body.messages[0].content.includes('Underwear is not available'),
    'a card with a stated adult age and no reference may keep underwear, and the code adds the adult sentence');
  const minorChat = await storyFor({ appearance: 'A woman, 34 years old, silver hair' }, 'Учитель заходит в школьный класс.');
  check((await scenePrompt(minorChat.story.id, 'adult_underwear')).prompt === null, 'a sign of a minor anywhere in the card or the chat vetoes underwear');
  const uploaded = await storyFor({ appearance: 'A woman, 34 years old, silver hair', imageUrl: reference });
  const uploadedScene = await scenePrompt(uploaded.story.id, 'adult_underwear');
  check(uploadedScene.prompt === null, 'an avatar that was not drawn here from text may be a real photo, so it never gets underwear');
  const beforeSquare = creates;
  refuseNext = 1;
  const refusedScene = await scenePrompt(noAge.story.id, 'ordinary');
  check(creates === beforeSquare + 2 && requests.at(-1).input.aspect_ratio === '1:1' && requests.at(-1).input.prompt === CLOTHED_REWRITE && refusedScene.body.jobId,
    'a refused scene is rewritten and stays square');
  await poll(refusedScene.body.jobId);
  check(['succeeded'].includes((await poll(refusedScene.body.jobId)).state), 'a rewritten scene finishes');

  check(!logs.join('\n').includes(REWRITTEN_PROMPT), 'logs omit the rewritten prompt');
  check(!logs.join('\n').includes(marker) && !logs.join('\n').includes(testEnv.KIE_API_KEY) && !logs.join('\n').includes('weathered innkeeper'),
    'logs omit prompt, written scene, provider text and API key');
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
