// Real Prisma queries/handlers against disposable local PostgreSQL. Never imports .env.
// --browser also exercises the production build with synthetic sessions and blocked external traffic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { createModuleLoader } from './lib/memory-test-harness.mjs';

// Historical accepted inputs, deliberately independent of the current taxonomy/Git HEAD.
const LEGACY_INPUTS = ['Мужчина', 'Девушка', 'Томбой', 'Антропоморфный', 'Пушистый',
  'Оригинальный персонаж', 'Сосед', 'Друг', 'Партнёр', 'Герой', 'Злодей', 'Враг', 'Офис',
  'Милый/Добрый', 'Цундере', 'Сложный', 'Флиртующий', 'От лица мужчины', 'От лица женщины', 'Брак',
  'Фэнтези', 'Драма', 'Аниме', 'Реалистичный', 'RPG', 'Экшен', 'Приключение', 'Комедия', 'Ужасы',
  'Sci-Fi', 'Мистика', 'Готика', 'Сверхъестественное', 'Симулятор', 'Романтика', 'Магия',
  'Постапокалипсис', 'Исторический', 'VR', 'Триллер', 'Пародия', 'Из медиа', 'Из игры', 'Монстр',
  'Мускулистый', 'Гигантский', 'Несколько персонажей', 'Игра', 'Сценарий', 'Пухлый', 'Эльф', 'Андроид'];

const root = process.cwd(), require = createRequire(import.meta.url);
const runtime = resolve(process.env['GUEST_TEST_RUNTIME'] || join(tmpdir(), 'nv-p1-isolated-runtime'));
const EmbeddedPostgres = require(join(runtime, 'node_modules/embedded-postgres/dist/index.js')).default;
async function freePort() {
  const socket = createServer();
  await new Promise((done, reject) => { socket.on('error', reject); socket.listen(0, '127.0.0.1', done); });
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  return port;
}
const directory = mkdtempSync(join(tmpdir(), 'nv-discovery-')), port = await freePort();
const databaseUrl = `postgresql://postgres:synthetic_discovery_only@127.0.0.1:${port}/nv_discovery`;
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_discovery_only',
  port, persistent: true, initdbFlags: ['--encoding=UTF8'], onLog() {} });
const env = { ...process.env };
for (const key of Object.keys(env)) if (/KEY|SECRET|TOKEN|PASSWORD|DATABASE|DIRECT_URL|LOGTAIL/i.test(key)) env[key] = '';
// Read variable names only, replacing any real configuration before starting local code.
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (existsSync(file)) for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = '';
}
Object.assign(env, { DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl, MIGRATION_DATABASE_URL: databaseUrl,
  NEXTAUTH_SECRET: 'synthetic_discovery_session', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' });
for (const key of Object.keys(process.env)) if (/LOGTAIL|AI_COST_/i.test(key)) delete process.env[key];
process.env.DATABASE_URL = databaseUrl;
process.env.NEXTAUTH_SECRET = env.NEXTAUTH_SECRET;
const db = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
const session = { userId: null }, { load } = createModuleLoader({ prismaFor: () => db, session });
let checks = 0, server, browser;
function check(value, label) { assert.ok(value, label); checks++; }
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
try {
  const tags = load(join(root, 'src/lib/characterTags.ts'));
  for (const tag of LEGACY_INPUTS) check(tags.normalizeTagsString(tag) !== null, `old tag retained or aliased: ${tag}`);
  equal(tags.parseTagsString('Sci-Fi, Научная фантастика, SCI-FI, Цуцере'), ['Научная фантастика', 'Цундере'], 'case-insensitive aliases deduplicated');
  equal(tags.normalizeTagsString('Пухлый, Детектив, unknown'), 'Пухлый, Детектив', 'legacy survives save, unknown does not enter taxonomy');
  equal(tags.recommendationTags('Пухлый, Из медиа, Sci-Fi'), ['Научная фантастика'], 'legacy tags do not distort preferences');
  const eight = tags.ALL_CHARACTER_TAGS.slice(0, 8).join(', ');
  equal(tags.toggleTagInString(eight, tags.ALL_CHARACTER_TAGS[8]), eight, 'picker refuses ninth tag');
  equal(tags.parseTagsString(tags.toggleTagInString(eight, tags.ALL_CHARACTER_TAGS[0])).length, 7, 'selection can still be removed at limit');
  for (const tag of tags.ALL_CHARACTER_TAGS) check(tags.characterTagLabel(tag, 'en') !== tag, `English label: ${tag}`);
  const { rankRecommendedCharacters } = load(join(root, 'src/lib/characterRecommendationRank.ts'));
  const now = new Date(), publicWhere = { isPublic: true, slug: { not: null } };
  const owner = await (async () => { await pg.initialise(); await pg.start(); await pg.createDatabase('nv_discovery');
    const schema = join(directory, 'schema.prisma');
    writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace(/Unsupported\("vector\(\d+\)"\)/g, 'Bytes'));
    const result = spawnSync(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', schema],
      { cwd: directory, env, encoding: 'utf8', timeout: 90000, windowsHide: true });
    if (result.status !== 0) throw new Error(`Private schema failed: ${result.stderr || result.stdout}`);
    return db.user.create({ data: { email: 'owner@example.test' } }); })();
  const alice = await db.user.create({ data: { email: 'alice@example.test' } });
  const bob = await db.user.create({ data: { email: 'bob@example.test' } });
  const cold = await db.user.create({ data: { email: 'cold@example.test' } });
  const examples = [
    ['fantasy-source', 'Фэнтези, Эльф', 100], ['fantasy-target', 'Фэнтези, Эльф', 100],
    ['space-source', 'Sci-Fi, Андроид', 100], ['space-target', 'Научная фантастика, Андроид', 100],
    ['huge-top', 'Комедия', 100000], ['romance-target', 'Романтика', 80],
  ];
  for (let i = 0; i < 30; i++) examples.push([`other-${i}`, ['Детектив', 'Драма', 'Романтика', 'Ужасы', 'Повседневность'][i % 5], 50 + i]);
  for (const [id, tag, totalMessages] of examples) await db.character.create({ data: {
    id, slug: id, name: id, name_en: id, tags: tag, userId: owner.id, isPublic: true,
    createdAt: now, totalMessages, privateMemory: 'PRIVATE_SENTINEL', systemPrompt: 'PROMPT_SENTINEL',
  } });
  for (const user of [alice, bob]) await db.character.create({ data: {
    id: `private-${user.id}`, name: 'PRIVATE_CARD_SENTINEL', slug: `private-${user.id}`, userId: user.id, isPublic: false,
    tags: 'Романтика', totalMessages: 900000,
  } });
  await db.favorite.createMany({ data: [
    { userId: alice.id, characterId: 'fantasy-source' }, { userId: bob.id, characterId: 'space-source' },
    { userId: alice.id, characterId: `private-${alice.id}` },
  ] });
  const message = (userId, characterId, extra = {}) => ({ userId, characterId, role: 'assistant', content: 'MESSAGE_SENTINEL', createdAt: now, ...extra });
  await db.message.createMany({ data: [message(alice.id, 'fantasy-source'), message(bob.id, 'space-source'),
    message(cold.id, 'romance-target', { role: 'user' }), message(cold.id, 'romance-target', { isAutoEvent: true }),
    message(cold.id, 'romance-target', { content: '' }), message(cold.id, 'romance-target', { createdAt: new Date(now.getTime() - 61 * 86400000) }),
    message(cold.id, `private-${alice.id}`),
  ] });
  const { getCharacterRecommendationOrder } = load(join(root, 'src/lib/characterRecommendations.ts'));
  const guest = await getCharacterRecommendationOrder(publicWhere, null, now);
  const a = await getCharacterRecommendationOrder(publicWhere, alice.id, now);
  const b = await getCharacterRecommendationOrder(publicWhere, bob.id, now);
  equal(a.ids[0], 'fantasy-target', 'favorite/chat preferences beat unrelated global popularity');
  equal(b.ids[0], 'space-target', 'other account has its own preferences, including old aliases');
  equal(guest.mode, 'discovery', 'guest cold start honestly labelled');
  equal((await getCharacterRecommendationOrder(publicWhere, cold.id, now)).mode, 'discovery', 'user messages, auto-events, empty/old/private replies do not personalize');
  equal((await getCharacterRecommendationOrder(publicWhere, alice.id, now)).ids, a.ids, 'same-day ranking stable');
  equal(new Set(a.ids).size, examples.length, 'every public candidate occurs exactly once');
  check(!a.ids.some(id => id.startsWith('private-')), 'no private candidates');
  const diverseCards = Array.from({ length: 20 }, (_, i) => ({ id: String(i), tags: i < 10 ? 'Фэнтези' : 'Комедия', roleplayMode: 'character', totalMessages: 10, createdAt: now }));
  const diverse = rankRecommendedCharacters(diverseCards, [], 'fixed', now).ids.slice(0, 6);
  check(diverse.some(id => Number(id) < 10) && diverse.some(id => Number(id) >= 10), 'cold start mixes available genres');

  const { GET } = load(join(root, 'src/app/api/characters/route.ts'));
  const { getPublicCatalog } = load(join(root, 'src/lib/publicCatalog.ts'));
  async function api(query, userId = null) {
    session.userId = userId;
    const response = await GET(new Request(`http://localhost/api/characters?${query}`));
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const pageOne = await api('sort=for-you&limit=24', alice.id), pageTwo = await api('sort=for-you&limit=24&page=2', alice.id);
  equal([...pageOne.body.data, ...pageTwo.body.data].map(row => row.id), a.ids, 'recommendation pagination has no reshuffle or duplicates');
  equal(pageOne.body.meta.recommendationMode, 'personalized', 'API reports personalized mode');
  check(pageOne.headers.get('cache-control')?.includes('no-store'), 'personalized API cannot be shared-cached');
  const ssr = await getPublicCatalog('for-you', 1, '');
  equal(ssr.data.map(row => row.id), pageOne.body.data.map(row => row.id), 'SSR and client agree on account and ranking');
  for (const tag of ['Sci-Fi', 'Научная фантастика', 'Science fiction']) {
    const filtered = await api(`sort=for-you&search=${encodeURIComponent(tag)}`, bob.id);
    equal(new Set(filtered.body.data.map(row => row.id)), new Set(['space-source', 'space-target']), `filter finds old and canonical spellings: ${tag}`);
    const serverFiltered = await getPublicCatalog('for-you', 1, tag);
    equal(serverFiltered.data.map(row => row.id), filtered.body.data.map(row => row.id), `SSR search parity: ${tag}`);
  }
  equal((await api('sort=top')).body.data[0].id, 'huge-top', 'Top keeps popularity ordering');
  equal((await api('public=false')).status, 401, 'anonymous private-list request rejected');
  const own = await api('public=false&sort=top', alice.id);
  equal(own.body.data.map(row => row.id), [`private-${alice.id}`], 'private-list request limited to owner');
  equal((await api(`userId=${bob.id}&public=false&sort=top`, alice.id)).body.data.length, 0, 'another owner cannot expose private cards');
  for (const sentinel of ['PRIVATE_SENTINEL', 'PROMPT_SENTINEL', 'MESSAGE_SENTINEL', 'PRIVATE_CARD_SENTINEL']) check(!JSON.stringify(pageOne.body).includes(sentinel), 'recommendation response excludes private text');

  if (process.argv.includes('--browser')) {
    const appPort = await freePort(), base = `http://127.0.0.1:${appPort}`;
    Object.assign(env, { NEXTAUTH_URL: base, NEXT_PUBLIC_APP_URL: base });
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(appPort)], { env, stdio: 'ignore', windowsHide: true });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (server.exitCode !== null) throw new Error('Local Next server exited');
      try { ready = (await fetch(base + '/robots.txt')).ok; } catch {}
      if (ready) break;
      await new Promise(done => setTimeout(done, 500));
    }
    check(ready, 'isolated production build starts');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    let currentUser = null, delayedResolve, holdNext = false, requests = 0, failNext = false;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/auth/session') return json(currentUser ? { user: { id: currentUser, email: 'browser@example.test', emailVerified: now.toISOString() }, expires: '2030-01-01T00:00:00Z' } : null);
      if (url.pathname === '/api/characters' && route.request().method() === 'GET') {
        requests++;
        const actor = currentUser, result = await api(url.search.slice(1), actor);
        if (holdNext) { holdNext = false; await new Promise(done => { delayedResolve = done; }); }
        if (failNext) { failNext = false; return json({ error: 'Synthetic failure' }, 503); }
        return json(result.body, result.status);
      }
      if (url.pathname === '/api/user/balance') return json({ verseCoins: 50, canClaimBonus: false, bonusStreak: 0 });
      if (url.pathname === '/api/avatar-tokens') return json({ tokensUsedThisMonth: 0, monthlyLimit: 10, monthlyRemaining: 10 });
      if (url.pathname === '/api/generate-avatar') return json({ state: 'none' });
      if (url.pathname.startsWith('/api/')) return json([]);
      return route.continue();
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const initialSession = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session');
    await page.goto(base + '/ru?sort=for-you');
    await initialSession;
    const refreshSession = () => page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', {
      key: 'nextauth.message', newValue: JSON.stringify({ event: 'session', data: { trigger: 'getSession' }, timestamp: Date.now() }),
    })));
    const cards = () => page.locator('main[data-character-list-scroll] a[href*="/character/"]:visible');
    await cards().first().waitFor();
    check(await page.getByText('Откройте новые истории', { exact: true }).isVisible(), 'mobile guest sees honest discovery title');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile catalog has no horizontal page overflow');
    currentUser = alice.id;
    await refreshSession();
    await page.waitForFunction(() => document.querySelector('main[data-character-list-scroll] a[href*="/character/"]')?.getAttribute('href')?.endsWith('/fantasy-target'));
    check(true, 'session change refreshes own recommendations');
    holdNext = true;
    await page.getByRole('group', { name: 'Сортировка', exact: true }).getByRole('button', { name: 'Топ', exact: true }).click();
    await page.waitForFunction(() => true);
    for (let i = 0; i < 40 && !delayedResolve; i++) await new Promise(done => setTimeout(done, 50));
    assert.ok(delayedResolve, 'held Alice request started');
    currentUser = bob.id;
    await refreshSession();
    await page.getByRole('group', { name: 'Сортировка', exact: true }).getByRole('button', { name: 'Для тебя', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('main[data-character-list-scroll] a[href*="/character/"]')?.getAttribute('href')?.endsWith('/space-target'));
    delayedResolve(); delayedResolve = null;
    await page.waitForTimeout(200);
    check((await cards().first().getAttribute('href')).endsWith('/space-target'), 'late previous-account request cannot overwrite new account');
    check(requests >= 3, 'account changes really fetch fresh lists');
    currentUser = cold.id; failNext = true;
    await refreshSession();
    await page.getByText('Synthetic failure', { exact: true }).waitFor();
    check(await page.getByText('Synthetic failure', { exact: true }).isVisible(), 'failed refresh does not leave endless spinner on account change');
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await cards().first().waitFor();
    check(true, 'retry recovers failed account refresh');
    await page.goto(base + '/ru/create/character');
    await page.getByRole('searchbox', { name: 'Найти тег', exact: true }).waitFor();
    const picker = page.locator('input[aria-label="Найти тег"]').locator('..');
    await picker.getByRole('button', { name: 'Детектив', exact: true }).click();
    check(await picker.getByRole('button', { name: 'Детектив', exact: true }).getAttribute('aria-pressed') === 'true', 'tag selector exposes selection state');
    await page.getByRole('searchbox', { name: 'Найти тег', exact: true }).fill('кибер');
    check(await picker.getByRole('button', { name: 'Киберпанк', exact: true }).isVisible(), 'tag search opens matching collapsed group');
    await picker.getByRole('button', { name: 'Киберпанк', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Найти тег', exact: true }).fill('');
    for (const tag of ['Романтика', 'Приключение', 'Фэнтези', 'Научная фантастика', 'Драма', 'Комедия']) await picker.getByRole('button', { name: tag, exact: true }).click();
    check(await picker.getByRole('button', { name: 'Ужасы', exact: true }).isDisabled(), 'browser prevents ninth tag');
    await picker.getByRole('button', { name: 'Убрать тег Детектив', exact: true }).click();
    check(await picker.getByRole('button', { name: 'Ужасы', exact: true }).isEnabled(), 'removing a tag reopens slot');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile editor remains within viewport');
    equal(errors, [], 'no browser hydration/runtime errors');
    await context.close();
  }
  console.log(`Character discovery: ${checks} tag/ranking/Prisma/handler${process.argv.includes('--browser') ? '/browser' : ''} checks passed`);
} finally {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const ended = new Promise(done => server.once('exit', done)); server.kill(); await ended;
  }
  await db.$disconnect();
  if (pg.process) {
    const child = pg.process, closed = new Promise(done => child.once('close', done));
    const native = join(runtime, 'node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe');
    if (existsSync(native)) {
      const result = spawnSync(native, ['-D', join(directory, 'db'), 'stop', '-m', 'fast', '-w', '-t', '15'], { windowsHide: true, stdio: 'ignore', timeout: 20000 });
      if (result.status !== 0) throw new Error('Private PostgreSQL shutdown failed');
      await closed;
    } else await pg.stop();
  }
}
