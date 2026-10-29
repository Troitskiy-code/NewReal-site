// Default: isolated handlers, database fixture and S3 transport. --live additionally
// exercises real Yandex S3 and disposable local PostgreSQL (never the production DB).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import sharp from 'sharp';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import * as s3Sdk from '@aws-sdk/client-s3';
import { NextRequest } from 'next/server.js';

const live = process.argv.includes('--live');
const require = createRequire(import.meta.url);
const env = live ? { ...dotenv.parse(readFileSync('.env')), ...dotenv.parse(readFileSync('.env.local')) } : {
  S3_ENDPOINT: 'https://storage.yandexcloud.net', S3_REGION: 'ru-central1', S3_BUCKET: 'fixture',
  S3_ACCESS_KEY_ID: 'fixture_access', S3_SECRET_ACCESS_KEY: 'fixture_secret',
};
const objects = new Map(), cards = new Map(), cleanupKeys = new Set(), fixtureUsers = [];
let embedded, isolatedDirectory;
async function stopEmbedded() {
  if (!embedded?.process) return;
  const child = embedded.process;
  if (child.exitCode !== null || child.signalCode !== null) { embedded.process = undefined; return; }
  if (process.platform !== 'win32') { await embedded.stop(); return; }
  const dataDirectory = join(isolatedDirectory, 'db');
  assert.equal(resolve(child.spawnargs[child.spawnargs.indexOf('-D') + 1]), resolve(dataDirectory));
  const closed = new Promise(done => child.once('close', done));
  const result = spawnSync(join(dirname(child.spawnfile), 'pg_ctl.exe'), ['stop', '-D', dataDirectory, '-m', 'fast', '-w', '-t', '15'],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.equal(result.status, 0, 'Disposable PostgreSQL shutdown');
  await closed; embedded.process = undefined;
}
if (live) {
  if (!process.env.GUEST_TEST_RUNTIME) throw new Error('GUEST_TEST_RUNTIME must point to the existing embedded-postgres installation');
  const EmbeddedPostgres = require(join(resolve(process.env.GUEST_TEST_RUNTIME), 'node_modules/embedded-postgres/dist/index.js')).default;
  const portServer = createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), 'nv-character-storage-'));
  isolatedDirectory = directory;
  embedded = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_fixture',
    port, persistent: true, onLog() {}, initdbFlags: ['--encoding=UTF8'] });
  await embedded.initialise(); await embedded.start(); await embedded.createDatabase('nv_storage_test');
  env.DATABASE_URL = `postgresql://postgres:synthetic_fixture@127.0.0.1:${port}/nv_storage_test`;
  env.DIRECT_URL = env.DATABASE_URL;
  const schema = join(directory, 'schema.prisma');
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace(/Unsupported\("vector\(\d+\)"\)/g, 'Bytes'));
  const setup = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', schema],
    { env: { ...process.env, DATABASE_URL: env.DATABASE_URL, DIRECT_URL: env.DATABASE_URL }, encoding: 'utf8', windowsHide: true, timeout: 90_000 });
  if (setup.status !== 0) { await stopEmbedded(); throw new Error('Disposable PostgreSQL schema setup failed'); }
}
let actor = null, storageFails = false, checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; console.log('PASS ' + label); };
const match = (row, where) => Object.entries(where).every(([key, value]) => key === 'OR'
  ? value.some(condition => match(row, condition)) : row[key] === value);
if (live) {
  const isolatedUrl = new URL(env.DATABASE_URL);
  if (isolatedUrl.hostname !== '127.0.0.1' || isolatedUrl.pathname !== '/nv_storage_test')
    throw new Error('Storage verification refuses non-disposable databases');
}
const db = live ? new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [] }) : {
  character: {
    async create({ data }) { const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data }; cards.set(row.id, row); return row; },
    async update({ where, data }) { const row = cards.get(where.id); Object.assign(row, data); return row; },
    async findUnique({ where }) { return cards.get(where.id) ?? null; },
    async findFirst({ where }) { return [...cards.values()].find(row => match(row, where)) ?? null; },
    async count() { return cards.size; },
    async deleteMany({ where }) { for (const [id, row] of cards) if (match(row, where)) cards.delete(id); },
  },
};
const realClient = live ? new s3Sdk.S3Client({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }) : null;
class TrackedClient extends s3Sdk.S3Client {
  async send(command, options) {
    if (storageFails) throw new Error('fixture_storage_down');
    if (command instanceof s3Sdk.PutObjectCommand) cleanupKeys.add(command.input.Key);
    if (live) return super.send(command, options);
    if (command instanceof s3Sdk.PutObjectCommand) { objects.set(command.input.Key, Buffer.from(command.input.Body)); return {}; }
    if (command instanceof s3Sdk.HeadObjectCommand) {
      if (!objects.has(command.input.Key)) throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
      return {};
    }
    throw new Error('Unexpected S3 command');
  }
}
const cache = new Map();
function load(file) {
  file = resolve(file); if (cache.has(file)) return cache.get(file);
  if (file.endsWith('.json')) { const value=JSON.parse(readFileSync(file,'utf8'));cache.set(file,value);return value; }
  const module = { exports: {} }; cache.set(file, module.exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const dependency = name => {
    if (name === '@aws-sdk/client-s3') return { ...s3Sdk, S3Client: TrackedClient };
    if (name === '@aws-sdk/s3-request-presigner' && !live) return { getSignedUrl: async (_client, command) =>
      'https://storage.yandexcloud.net/fixture/' + command.input.Key + '?fixture-signature=1' };
    if (name === '@/lib/prisma') return { prisma: db };
    if (name === '@/lib/auth') return { authOptions: {} };
    if (name === 'next-auth/next') return { getServerSession: async () => actor ? { user: { id: actor } } : null };
    if (name === '@/lib/translate') return { translateCharacterFieldsToEn: async () => ({}), translateMemoryFieldToEn: async () => null };
    if (name === '@/lib/characterTranslationQueue') return { enqueueCharacterTranslations: async () => {}, saveManualEnglishTranslation: async () => {} };
    if (name === '@/lib/aiCostTelemetry') return { withAiCostContext: fn => fn(), setAiCostActor() {} };
    if (name === '@/lib/logger' || name === './logger') return { errorLog() {}, toSafeDiagnostic: () => ({}) };
    if (name === '@/lib/ensureCharacterSlug') return { ensureCharacterSlugColumn: async () => {} };
    if (name === '@/lib/ensureCharacterModerationColumns') return { ensureCharacterModerationColumns: async () => {} };
    if (name === '@/lib/characterPublic') return { allocateCharacterSlug: async (_name, id) => 'storage-verification-' + id };
    if (name === '@/lib/characterRecommendations') return {};
    if (name.startsWith('@/') || name.startsWith('.')) {
      const target = name.startsWith('@/') ? resolve('src', name.slice(2)) : resolve(dirname(file), name);
      const found = [target, target + '.ts', target + '.js'].find(existsSync);
      return load(found);
    }
    return require(name);
  };
  const providerFetch = async url => {
    if (String(url) === 'https://tempfile.aiquickdraw.com/storage-fixture.png') return new Response(png);
    throw new Error('Paid provider requests forbidden in storage verification');
  };
  new Function('require', 'module', 'exports', 'process', 'console', 'fetch', code)(dependency, module, module.exports,
    { env }, { log() {} }, providerFetch);
  return module.exports;
}
const media = load('src/lib/characterMedia.ts');
const upload = load('src/app/api/upload/route.js');
const create = load('src/app/api/characters/route.ts');
const edit = load('src/app/api/characters/[id]/route.ts');
const avatar = load('src/app/api/characters/[id]/avatar/route.ts');
const preview = load('src/app/api/character-media/[owner]/[asset]/route.ts');
const kie = load('src/lib/kieAi.ts');
const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#7394ab' } }).png().toBuffer();
const inline = 'data:image/png;base64,' + png.toString('base64');
const post = body => new NextRequest('https://example.test/api/characters', { method: 'POST', body: JSON.stringify(body) });
const put = body => new NextRequest('https://example.test/api/characters/fixture', { method: 'PUT', body: JSON.stringify(body) });
const imageRequest = () => { const form = new FormData(); form.set('file', new Blob([png], { type: 'image/png' }), 'fixture.png');
  return new Request('https://example.test/api/upload', { method: 'POST', body: form }); };
const context = id => ({ params: Promise.resolve({ id }) });
async function readImage(path) {
  const parsed = media.parseCharacterMediaPath(path);
  if (!live) return objects.get(parsed.key);
  const result = await realClient.send(new s3Sdk.GetObjectCommand({ Bucket: env.S3_BUCKET, Key: parsed.key }), { abortSignal: AbortSignal.timeout(20_000) });
  return Buffer.from(await result.Body.transformToByteArray());
}
let owner, other;
try {
  if (live) {
    check(Object.keys(env).filter(key => key.startsWith('S3_')).length >= 5, 'live storage configuration available');
    for (const name of ['owner', 'other']) {
      const user = await db.user.create({ data: { email: `storage-verification-${name}-${randomUUID()}@example.invalid`, name: 'Temporary storage verification' } });
      fixtureUsers.push(user.id);
    }
    [owner, other] = fixtureUsers;
  } else { owner = 'fixture_owner'; other = 'fixture_other'; }
  check((await upload.POST(imageRequest())).status === 401, 'anonymous upload rejected before storage');
  actor = owner;
  const uploaded = await upload.POST(imageRequest());
  const imageUrl = (await uploaded.json()).url;
  check(uploaded.status === 200 && !!media.parseCharacterMediaPath(imageUrl), 'editor upload returns stable storage reference');
  check((await sharp(await readImage(imageUrl)).metadata()).format === 'webp', 'actual stored object is a readable WebP image');
  const draft = media.parseCharacterMediaPath(imageUrl);
  check((await preview.GET(new NextRequest('https://example.test' + imageUrl),
    { params: Promise.resolve({ owner, asset: draft.assetId }) })).status === 307,
    'uploader can preview the image before a character is created');
  const oversized = new Request('https://example.test/api/upload', { method: 'POST', duplex: 'half',
    headers: { 'content-type': 'multipart/form-data; boundary=fixture' }, body: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(media.MAX_CHARACTER_IMAGE_BYTES + 256 * 1024 + 1)); controller.close(); },
    }) });
  check((await upload.POST(oversized)).status === 413, 'chunked multipart upload cannot bypass the byte limit');
  const created = await create.POST(post({ name: 'Storage verification (temporary)', imageUrl, imageLora: inline,
    description: 'Disposable private verification character', greeting: 'Verification', isPublic: false }));
  check(created.status === 201, 'real character creation handler accepts uploaded avatar and inline reference');
  const card = await created.json();
  const stored = await db.character.findUnique({ where: { id: card.id } });
  check(!!media.parseCharacterMediaPath(stored.imageUrl) && !!media.parseCharacterMediaPath(stored.imageLora)
    && !JSON.stringify(stored).includes('data:image/'), 'database card stores object references instead of base64 images');
  const privateAvatar = await avatar.GET(new NextRequest('https://example.test/api/characters/' + card.id + '/avatar'), context(card.id));
  check(privateAvatar.status === 307 && privateAvatar.headers.get('cache-control').includes('no-store'), 'owner receives uncached download redirect');
  if (live) {
    const download = await fetch(privateAvatar.headers.get('location'), { signal: AbortSignal.timeout(20_000) });
    check(download.ok && (await sharp(Buffer.from(await download.arrayBuffer())).metadata()).format === 'webp', 'signed Yandex download URL returns the created character avatar');
  }
  const parsed = media.parseCharacterMediaPath(imageUrl);
  const previewContext = { params: Promise.resolve({ owner, asset: parsed.assetId }) };
  actor = other;
  check((await preview.GET(new NextRequest('https://example.test' + imageUrl), previewContext)).status === 404,
    'other account cannot access private upload');
  check((await avatar.GET(new NextRequest('https://example.test/api/characters/' + card.id + '/avatar'), context(card.id))).status === 404,
    'other account cannot access private character avatar');
  check((await create.POST(post({ name: 'Forbidden fixture', imageUrl }))).status === 400, 'cannot attach another user’s object');
  actor = owner;
  check((await edit.PUT(put({ imageUrl: inline }), context(card.id))).status === 200, 'avatar replacement is uploaded to object storage');
  const replacement = await db.character.findUnique({ where: { id: card.id } });
  check(replacement.imageUrl !== imageUrl && (await sharp(await readImage(replacement.imageUrl)).metadata()).format === 'webp',
    'replacement creates a readable new object and updates DB reference');
  check((await edit.PUT(put({ imageUrl: null }), context(card.id))).status === 200, 'clearing an avatar remains supported');
  await db.character.update({ where: { id: card.id }, data: { imageUrl, isPublic: true } });
  actor = null;
  check((await preview.GET(new NextRequest('https://example.test' + imageUrl), previewContext)).status === 307, 'published avatar can be viewed anonymously');
  await db.character.update({ where: { id: card.id }, data: { isPublic: false } });
  check((await preview.GET(new NextRequest('https://example.test' + imageUrl), previewContext)).status === 404,
    'public-to-private change blocks fresh anonymous access');
  actor = owner;
  check((await create.POST(post({ name: 'Invalid image', imageUrl: 'data:image/png;base64,AAAA' }))).status === 400,
    'invalid image rejected without saving a character');
  check((await create.POST(post({ name: 'External image', imageUrl: 'http://127.0.0.1/private' }))).status === 400,
    'new arbitrary remote image URL rejected without fetching it');
  check((await create.POST(post({ name: 'Missing image', imageUrl: `/api/character-media/${owner}/${'0'.repeat(32)}` }))).status === 400,
    'nonexistent object cannot be attached');
  const repeatJob = randomUUID();
  const generatedA = await kie.saveKieImage('https://tempfile.aiquickdraw.com/storage-fixture.png', owner, repeatJob);
  const generatedB = await kie.saveKieImage('https://tempfile.aiquickdraw.com/storage-fixture.png', owner, repeatJob);
  check(generatedA === generatedB, 'generation retries reuse the same object key');
  const generatedCard = await create.POST(post({ name: 'Generated-avatar verification (temporary)', imageUrl: generatedA, isPublic: false }));
  check(generatedCard.status === 201 && (await sharp(await readImage(generatedA)).metadata()).format === 'webp',
    'generated avatar persistence path creates a character backed by a real storage object');
  const oldRows = await db.character.count({ where: { userId: owner } });
  storageFails = true;
  check((await create.POST(post({ name: 'Storage failure', imageUrl: inline }))).status === 503
    && await db.character.count({ where: { userId: owner } }) === oldRows,
    'storage outage cannot silently save base64 or create a broken character');
  storageFails = false;
  await db.character.update({ where: { id: card.id }, data: { imageUrl: inline } });
  const oldAvatar = await avatar.GET(new NextRequest('https://example.test/api/characters/' + card.id + '/avatar'), context(card.id));
  check(oldAvatar.status === 200 && Buffer.from(await oldAvatar.arrayBuffer()).equals(png), 'legacy inline avatars still render');
  console.log(`Verified ${checks} checks (${live ? 'live Yandex storage and PostgreSQL' : 'isolated fixtures'}).`);
} catch (error) {
  // Never print connection strings, SDK requests or signed URLs.
  console.log('Verification failed: ' + (error instanceof assert.AssertionError ? error.message : error?.name || 'Error'));
  process.exitCode = 1;
} finally {
  if (live) {
    for (const userId of fixtureUsers) {
      await db.character.deleteMany({ where: { userId } });
      await db.user.delete({ where: { id: userId } });
    }
    for (const Key of cleanupKeys) await realClient.send(new s3Sdk.DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key }),
      { abortSignal: AbortSignal.timeout(15_000) });
    await db.$disconnect(); realClient.destroy(); await stopEmbedded();
    if (!process.exitCode) writeFileSync('docs/character-storage-verification.json', JSON.stringify({
      verifiedAt: new Date().toISOString(), bucket: env.S3_BUCKET, checks,
      mode: 'real Yandex S3 + disposable local PostgreSQL + actual route handlers; fixture authentication, translations and provider image response',
      cleanup: 'Temporary users, characters and objects removed after verification',
    }, null, 2) + '\n');
  }
}
