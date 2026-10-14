// Actual queue/transactions/admin routes against disposable PostgreSQL. All paid
// providers and storage are simulated; never loads .env or the production DB.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { NextRequest } from 'next/server.js';
import { startCharacterGenerationWorker } from './lib/character-generation-worker.mjs';

const require = createRequire(import.meta.url), root = process.cwd();
const runtime = process.env.GUEST_TEST_RUNTIME;
if (!runtime) throw new Error('Set GUEST_TEST_RUNTIME to the existing isolated embedded-postgres installation');
const EmbeddedPostgres = require(join(resolve(runtime), 'node_modules/embedded-postgres/dist/index.js')).default;
const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port; await new Promise(done => socket.close(done));
const directory = mkdtempSync(join(tmpdir(), 'nv-character-generation-'));
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_fixture',
  port, persistent: true, onLog() {}, initdbFlags: ['--encoding=UTF8'] });
const databaseUrl = `postgresql://postgres:synthetic_fixture@127.0.0.1:${port}/nv_character_generation_test`;
const db = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
const ddl = new Client({ connectionString: databaseUrl });
const env = { DEEPINFRA_API_KEY: 'fixture', DEEPINFRA_USD_RUB: '108.192', KIE_API_KEY: 'fixture', YANDEX_API_KEY: 'fixture',
  YANDEX_FOLDER_ID: 'fixture', S3_ENDPOINT: 'https://storage.yandexcloud.net', S3_REGION: 'ru-central1', S3_BUCKET: 'fixture',
  S3_ACCESS_KEY_ID: 'fixture', S3_SECRET_ACCESS_KEY: 'fixture', ADMIN_SECRET: 'fixture_admin', CRON_SECRET: 'fixture_cron' };
let ownerId, sessionOwner, textMode = 'ok', imageMode = 'ok', translationFailures = 0, reviewMode = 'ok';
let textCalls = 0, imageCalls = 0, translationCalls = 0, saves = 0;
const imageTasks = new Map(), logs = [], cache = new Map();
class FixtureKieError extends Error { constructor(code, rejected = false) { super(code); this.code = code; this.rejected = rejected; } }
const cardFixture = theme => {
  const sentence = 'Персонаж сохраняет самостоятельность, уважает решения собеседника, действует последовательно и постепенно раскрывает свои мотивы в разговоре. ';
  return { name: theme.name, descriptionCard: theme.premise, description: theme.premise + sentence.repeat(3),
    appearance: 'Взрослый персонаж, аккуратная одежда, выразительный взгляд, спокойная уверенная поза. ' + sentence,
    greeting: theme.opening + ' «С какого условия начнём? Я готов выслушать твой вариант и объяснить свой».',
    scenario: theme.premise, exampleDialogs: '{{user}}: Почему ты выбрал меня?\n{{char}}: ' + sentence + '\n{{user}}: Я хочу другой вариант.\n{{char}}: ' + sentence,
    avatarPrompt: 'Взрослый персонаж в аккуратной одежде, спокойный уверенный взгляд, соответствующее сюжету окружение, мягкое освещение, портрет. ',
    tags: 'Романтика, Партнёр, Медленное развитие отношений',
    rpConfig: Object.fromEntries(['motivations','speechStyle','relationships','world','narrativeRules','canonicalNotes'].map(key => [key, sentence])) };
};
function load(file) {
  file = resolve(file); if (cache.has(file)) return cache.get(file);
  const mod = { exports: {} }; cache.set(file, mod.exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const dependency = name => {
    if (name === './prisma' || name === '@/lib/prisma') return { prisma: db };
    if (name === '@/lib/auth') return { authOptions: {} };
    if (name === 'next-auth/next') return { getServerSession: async () => sessionOwner ? { user: { id: sessionOwner } } : null };
    if (name === './logger' || name === '@/lib/logger') return { errorLog: (...args) => logs.push(args), toSafeDiagnostic: () => ({}) };
    if (name === './aiCostTelemetry') return { withAiCostContext: fn => fn() };
    if (name === './aiTextClient') return { serviceChatPost: async (_purpose, _url, body) => {
      if (body.messages[0].content.startsWith('Ты проверяешь')) {
        return { data: { usage: { prompt_tokens: 1000, completion_tokens: 100 }, choices: [{ message: { content: JSON.stringify({ approved: reviewMode === 'ok', issues: 'Исправьте противоречие внешности и изображения' }) } }] } };
      }
      textCalls++;
      if (textMode === 'lost') throw new Error('fixture network timeout');
      const theme = JSON.parse(body.messages[1].content).theme;
      return { data: { usage: { prompt_tokens: 1000, completion_tokens: 2000 }, choices: [{ message: { content:
        textMode === 'invalid' ? '{}' : JSON.stringify(cardFixture(theme)) } }] } };
    } };
    if (name === './translate') return { translateText: async text => {
      translationCalls++;
      if (translationFailures > 0) { translationFailures--; throw new Error('fixture translation timeout'); }
      return 'English translation of the complete character field. Source length: ' + text.length;
    } };
    if (name === './kieAi') return {
      KieError: FixtureKieError, isKieTaskId: id => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(id),
      createKieAvatar: async prompt => {
        imageCalls++; const id = 'fixture_image_' + imageCalls; imageTasks.set(id, { prompt });
        if (imageMode === 'lost') throw new FixtureKieError('lost_response');
        if (imageMode === 'rejected') throw new FixtureKieError('safety', true);
        return id;
      },
      getKieAvatarTask: async id => {
        if (!imageTasks.has(id)) throw new Error('unknown fixture task');
        return { model: 'seedream/5-flash-text-to-image', state: 'success', credits: 3.24, imageUrl: 'https://tempfile.aiquickdraw.com/fixture.png' };
      },
      saveKieImage: async (_url, owner, id) => { saves++; return `/api/character-media/${owner}/${id.replaceAll('-', '').slice(0, 32)}`; },
    };
    if (name.startsWith('@/') || name.startsWith('.')) {
      const target = name.startsWith('@/') ? resolve('src', name.slice(2)) : resolve(dirname(file), name);
      if (target.endsWith('.json')) return JSON.parse(readFileSync(target, 'utf8'));
      const found = [target, target + '.ts', target + '.js'].find(existsSync);
      return load(found);
    }
    return require(name);
  };
  new Function('require','module','exports','process','console',code)(dependency,mod,mod.exports,{env},{log(){}});
  return mod.exports;
}
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log('PASS ' + label); };
const req = (body, secret = 'fixture_admin') => new NextRequest('https://example.test/api/admin/character-generation', {
  method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + secret }, ...(body ? { body: JSON.stringify(body) } : {}) });
let jobs, admin, cron;
async function accelerate() { await db.characterGenerationItem.updateMany({ data: { nextRunAt: new Date() } }); }
async function drain(batch, max = 200) {
  for (let i=0; i<max; i++) {
    await accelerate(); await jobs.processGenerationStep();
    const current = await db.characterGenerationBatch.findUnique({ where: { id: batch.id } });
    if (current.state !== 'running') return current;
  }
  throw new Error('Fixture batch did not finish');
}
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('nv_character_generation_test'); await ddl.connect();
  const schema = join(directory, 'schema.prisma');
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace(/Unsupported\("vector\(\d+\)"\)/g, 'Bytes'));
  const setup = spawnSync(process.execPath, ['node_modules/prisma/build/index.js','db','push','--skip-generate','--schema',schema],
    { env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }, encoding: 'utf8', windowsHide: true, timeout: 90_000 });
  assert.equal(setup.status, 0, 'isolated schema setup');
  const owner = await db.user.create({ data: { email: 'generation@example.test', tokensUsedThisMonth: 3 } });
  ownerId = sessionOwner = owner.id;
  await db.character.create({ data: { name: 'Existing fixture card', userId: ownerId, isPublic: true } });
  await ddl.query('DROP TABLE "CharacterGenerationAttempt", "CharacterGenerationItem", "CharacterGenerationBatch"');
  await ddl.query(`CREATE TABLE "_prisma_migrations" (
    id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, finished_at TIMESTAMPTZ,
    migration_name VARCHAR(255) NOT NULL, logs TEXT, rolled_back_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), applied_steps_count INTEGER NOT NULL DEFAULT 0)`);
  const migrate = () => spawnSync(process.execPath, ['scripts/apply-character-generation-migration.mjs'], {
    env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
    encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(migrate().status, 0, 'feature migration installer');
  assert.equal(migrate().status, 0, 'feature migration replay');
  check(await db.character.count() === 1, 'additive migration preserves existing characters');
  check((await ddl.query('SELECT COUNT(*)::int AS count FROM "_prisma_migrations"')).rows[0].count === 1,
    'migration installer records one checksum and tolerates replay');
  jobs = load('src/lib/characterGeneration.ts'); admin = load('src/app/api/admin/character-generation/route.ts');
  cron = load('src/app/api/cron/generate-characters/route.ts');
  check((await admin.GET(req(null, 'wrong'))).status === 401, 'admin secret required for reads');
  sessionOwner = null;
  check((await admin.POST(req({ action:'start',clientKey:randomUUID(),count:1,budgetRub:200 }))).status === 401, 'admin secret does not replace owner login');
  sessionOwner = ownerId;
  check(!(await jobs.generationStatus(ownerId)).workerEnabled, 'dev or direct startup never claims an internal worker is active');
  env.CHARACTER_GENERATION_WORKER_ACTIVE = '1';
  check((await jobs.generationStatus(ownerId)).workerEnabled, 'production wrapper announces the configured background worker');
  check((await cron.POST(req({}, 'wrong'))).status === 401, 'background endpoint requires cron secret');
  const key = randomUUID();
  const first = await jobs.createGenerationBatch(ownerId,key,10,200);
  const replay = await jobs.createGenerationBatch(ownerId,key,10,200);
  check(first.id === replay.id && await db.characterGenerationItem.count({where:{batchId:first.id}}) === 10, 'replayed start creates one party and ten jobs');
  const pause = await jobs.controlGenerationBatch(ownerId, first.id, 'pause');
  const priorCalls = textCalls;
  check(pause.state === 'paused' && !(await jobs.processGenerationStep()).processed && textCalls === priorCalls, 'pause prevents new paid work');
  await jobs.controlGenerationBatch(ownerId,first.id,'resume');
  const golden = await drain(first);
  check(golden.state === 'completed', 'all ten cards finish without browser polling');
  const ready = await db.characterGenerationItem.findMany({where:{batchId:first.id},orderBy:{position:'asc'}});
  const cards = await db.character.findMany({where:{id:{in:ready.map(i=>i.characterId)}}});
  check(cards.length === 10 && cards.every(c=>!c.isPublic && c.imageUrl.startsWith('/api/character-media/') && c.name_en && c.greeting_en),
    'ten private drafts contain storage links and complete English fields');
  check(imageCalls === 10 && saves === 10 && await db.avatarQuotaReservation.count() === 0
    && (await db.user.findUnique({where:{id:ownerId}})).tokensUsedThisMonth === 3, 'catalog generation does not consume user avatar quota');
  check(golden.spentKopecks + golden.reservedKopecks <= 20000 && golden.reservedKopecks === 0, 'settled costs stay within batch ceiling');
  const noChangeCount = await db.character.count();
  await jobs.processGenerationStep();
  check(await db.character.count() === noChangeCount && imageCalls === 10, 'finished jobs never create duplicate characters or paid tasks');
  await jobs.controlGenerationBatch(ownerId, first.id, 'publish', ready[0].id);
  check((await db.character.findUnique({where:{id:ready[0].characterId}})).isPublic, 'reviewed draft can be published explicitly');
  check((await jobs.generationStatus(ownerId)).batches.find(b=>b.id===first.id).items[0].isPublic,
    'admin status reflects publication');
  const other = await db.user.create({data:{email:'other@example.test'}});
  await assert.rejects(jobs.controlGenerationBatch(other.id,first.id,'publish',ready[1].id));
  check(true, 'another owner cannot publish or control a batch');
  await db.character.update({where:{id:ready[0].characterId},data:{isPublic:false}});
  // Same themes now duplicate the public/owner catalogue and must fail before images.
  const duplicates = await jobs.createGenerationBatch(ownerId,randomUUID(),1,200);
  const beforeDuplicateImages=imageCalls; await drain(duplicates);
  check(imageCalls === beforeDuplicateImages && (await db.characterGenerationItem.findFirst({where:{batchId:duplicates.id}})).state === 'failed',
    'duplicate name/card is rejected before avatar payment');
  // Use a separate owner to avoid interference from deliberately duplicated concepts.
  ownerId = sessionOwner = other.id;
  const low = await jobs.createGenerationBatch(ownerId,randomUUID(),1,1);
  const beforeLow=imageCalls; const lowResult=await drain(low);
  check(imageCalls===beforeLow && lowResult.spentKopecks+lowResult.reservedKopecks<=100
    && (await db.characterGenerationItem.findFirst({where:{batchId:low.id}})).errorCode==='budget', 'small budget stops before avatar payment without overspending');
  const lost = await jobs.createGenerationBatch(ownerId,randomUUID(),1,200); imageMode='lost';
  await drain(lost); const uncertain=await db.characterGenerationItem.findFirst({where:{batchId:lost.id}});
  const lostCalls=imageCalls;
  check(uncertain.state==='uncertain' && uncertain.errorCode==='image_uncertain', 'lost image-create response becomes durable attention state');
  await assert.rejects(jobs.controlGenerationBatch(ownerId,lost.id,'retry',uncertain.id));
  await jobs.processGenerationStep();
  check(imageCalls===lostCalls, 'unknown paid image is never automatically submitted again');
  imageMode='ok';
  await jobs.controlGenerationBatch(ownerId,lost.id,'recover',uncertain.id,'fixture_image_'+imageCalls);
  await drain(lost);
  check(imageCalls===lostCalls && (await db.characterGenerationItem.findUnique({where:{id:uncertain.id}})).state==='ready', 'recovering provider task reuses paid result');
  // Simulate process death after a reservation, before the response checkpoint.
  const staleOwner=await db.user.create({data:{email:'stale@example.test'}});
  const stale=await jobs.createGenerationBatch(staleOwner.id,randomUUID(),1,200);
  const staleItem=await db.characterGenerationItem.findFirst({where:{batchId:stale.id}});
  await db.characterGenerationItem.update({where:{id:staleItem.id},data:{leaseToken:'dead_worker',leaseUntil:new Date(Date.now()-1000)}});
  await db.characterGenerationAttempt.create({data:{id:randomUUID(),itemId:staleItem.id,stage:'text',number:1,reservedKopecks:100}});
  await db.characterGenerationBatch.update({where:{id:stale.id},data:{reservedKopecks:100}});
  await jobs.processGenerationStep();
  check((await db.characterGenerationAttempt.findFirst({where:{itemId:staleItem.id,number:1}})).state==='uncertain', 'restart retains cost of interrupted text attempt');
  await jobs.controlGenerationBatch(staleOwner.id,stale.id,'pause');
  const brokenOwner=await db.user.create({data:{email:'broken@example.test'}});
  const broken=await jobs.createGenerationBatch(brokenOwner.id,randomUUID(),1,200); textMode='invalid';
  await drain(broken); textMode='ok';
  check(await db.characterGenerationAttempt.count({where:{item:{batchId:broken.id},stage:'text'}})===2
    && (await db.characterGenerationItem.findFirst({where:{batchId:broken.id}})).state==='failed', 'invalid card retries at most twice');
  check(!(await jobs.generationStatus(brokenOwner.id)).batches[0].items[0].canRetry,
    'exhausted stages do not offer another paid retry');
  const translateOwner=await db.user.create({data:{email:'translation@example.test'}});
  const partial=await jobs.createGenerationBatch(translateOwner.id,randomUUID(),1,200);
  for(let i=0;i<6;i++){await accelerate();await jobs.processGenerationStep();}
  const partialItem=await db.characterGenerationItem.findFirst({where:{batchId:partial.id}});
  const alreadyTranslated=Object.keys(partialItem.translations??{});
  translationFailures=1; await accelerate();await jobs.processGenerationStep();
  await drain(partial);
  const partialDone=await db.characterGenerationItem.findUnique({where:{id:partialItem.id}});
  check(alreadyTranslated.length>0 && partialDone.state==='ready' && alreadyTranslated.every(k=>partialDone.translations[k]===partialItem.translations[k]),
    'translation retry keeps previously saved English fields');
  const concurrentOwner=await db.user.create({data:{email:'concurrent@example.test'}});
  const concurrent=await jobs.createGenerationBatch(concurrentOwner.id,randomUUID(),3,6);
  const concurrencyBefore=textCalls;
  await accelerate(); await Promise.all([jobs.processGenerationStep(),jobs.processGenerationStep(),jobs.processGenerationStep(),jobs.processGenerationStep()]);
  const concurrentCosts=await db.characterGenerationBatch.findUnique({where:{id:concurrent.id}});
  check(concurrentCosts.spentKopecks+concurrentCosts.reservedKopecks<=600 && textCalls-concurrencyBefore<=3, 'concurrent workers cannot overspend shared ceiling');
  await jobs.controlGenerationBatch(concurrentOwner.id,concurrent.id,'pause');
  const reviewOwner=await db.user.create({data:{email:'review@example.test'}});
  const rejected=await jobs.createGenerationBatch(reviewOwner.id,randomUUID(),1,200); reviewMode='reject';
  const priorImages=imageCalls; await drain(rejected); reviewMode='ok';
  check(imageCalls===priorImages && (await db.characterGenerationItem.findFirst({where:{batchId:rejected.id}})).state==='failed', 'semantic rejection repairs text before paying for an avatar');
  let ticks=0, seenAuth;
  const worker=startCharacterGenerationWorker({port:'3456',secret:'fixture_cron',intervalMs:2,fetchImpl:async(url,init)=>{
    assert.equal(url,'http://127.0.0.1:3456/api/cron/generate-characters'); ticks++;seenAuth=init.headers.Authorization; return Response.json({processed:false}); }});
  await new Promise(done=>setTimeout(done,30)); worker.stop(); const stopped=ticks;
  await new Promise(done=>setTimeout(done,20));
  check(stopped>0 && ticks===stopped && seenAuth==='Bearer fixture_cron', 'server worker polls authenticated loopback and stops cleanly');
  const beforeRead=textCalls+imageCalls+translationCalls; sessionOwner=other.id;
  check((await admin.GET(req())).status===200 && textCalls+imageCalls+translationCalls===beforeRead, 'status reads never perform paid work');
  check(!JSON.stringify(logs).includes('fixture_admin')&&!JSON.stringify(logs).includes('fixture_cron'), 'logs contain no administrative credentials');
  writeFileSync('docs/character-generation-verification.json',JSON.stringify({verifiedAt:new Date().toISOString(),checks,
    mode:'Disposable PostgreSQL; actual worker/admin routes; simulated paid providers and storage',paidCalls:0,productionDatabaseAccess:false},null,2)+'\n');
  console.log(`Character generation: ${checks} checks passed. No paid calls or production DB access.`);
} finally {
  await db.$disconnect(); await ddl.end();
  if(process.platform==='win32'&&pg.process){const child=pg.process;
    assert.equal(resolve(child.spawnargs[child.spawnargs.indexOf('-D')+1]),resolve(join(directory,'db')));
    const closed=new Promise(done=>child.once('close',done));
    const stop=spawnSync(join(dirname(child.spawnfile),'pg_ctl.exe'),['stop','-D',join(directory,'db'),'-m','fast','-w','-t','15'],
      {encoding:'utf8',windowsHide:true,timeout:20000}); assert.equal(stop.status,0);await closed;pg.process=undefined;
  }else await pg.stop();
}
