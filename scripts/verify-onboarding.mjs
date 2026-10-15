// "Первый шаг" onboarding: real Prisma queries and handlers against disposable local PostgreSQL. Never imports .env.
// --browser also walks the picker in the production build (run `npm run build` first) with external traffic blocked.
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
const directory = mkdtempSync(join(tmpdir(), 'nv-onboarding-')), port = await freePort();
const databaseUrl = `postgresql://postgres:synthetic_onboarding_only@127.0.0.1:${port}/nv_onboarding`;
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_onboarding_only',
  port, persistent: true, initdbFlags: ['--encoding=UTF8'], onLog() {} });
const env = { ...process.env };
for (const key of Object.keys(env)) if (/KEY|SECRET|TOKEN|PASSWORD|DATABASE|DIRECT_URL|LOGTAIL/i.test(key)) env[key] = '';
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (existsSync(file)) for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = '';
}
Object.assign(env, { DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl, MIGRATION_DATABASE_URL: databaseUrl,
  NEXTAUTH_SECRET: 'synthetic_onboarding_session', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', ONBOARDING_ENABLED: 'true' });
for (const key of Object.keys(process.env)) if (/LOGTAIL|AI_COST_/i.test(key)) delete process.env[key];
process.env.DATABASE_URL = databaseUrl;
process.env.ADMIN_SECRET = 'synthetic_admin_secret';

// next/headers only works inside a request; the handlers read this stub instead.
const request = { cookie: null, userAgent: 'Mozilla/5.0 Synthetic' };
globalThis.__onboardingHeaders = {
  cookies: async () => ({ get: name => name === 'nv_onboarding' && request.cookie ? { value: request.cookie } : undefined }),
  headers: async () => new Headers({ 'user-agent': request.userAgent }),
};
const db = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
const session = { userId: null };
const { load } = createModuleLoader({ prismaFor: () => db, session,
  sourceTransform: (file, source) => source.replace(/import \{([^}]*)\} from "next\/headers";/, 'const {$1} = globalThis.__onboardingHeaders;') });
let checks = 0, server, browser;
function check(value, label) { assert.ok(value, label); checks++; }
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

try {
  const onboarding = load(join(root, 'src/lib/onboarding.ts'));
  const prefs = { status: 'completed', style: 'anime', interests: ['romance', 'fantasy'], gender: 'female' };
  equal(onboarding.parseOnboardingPrefs(onboarding.serializeOnboardingPrefs(prefs)), prefs, 'cookie round trip');
  equal(onboarding.serializeOnboardingPrefs({ status: 'skipped', style: null, interests: [], gender: null }), '1.skipped.-.-.-', 'skip cookie carries no answers');
  equal(onboarding.parseOnboardingPrefs('2.completed.anime.romance.-'), null, 'unknown cookie version ignored');
  equal(onboarding.parseOnboardingPrefs('1.done.anime.romance.-'), null, 'unknown status ignored');
  equal(onboarding.parseOnboardingPrefs('1.completed.cartoon.romance-hacking-drama-comedy-fantasy.x').interests, ['romance', 'drama', 'comedy'],
    'unknown interests dropped and capped at three');
  equal(onboarding.parseOnboardingPrefs('1.completed.cartoon.-.x').style, null, 'unknown style dropped');
  equal(onboarding.resolveArtStyle('realistic', 'Аниме, Романтика'), 'realistic', 'stored style wins over the tag');
  equal(onboarding.resolveArtStyle(null, 'Аниме'), 'anime', 'Аниме tag is the fallback');
  equal(onboarding.resolveArtStyle(null, 'Романтика'), null, 'untagged card stays unknown');
  equal(onboarding.matchedOnboardingInterests('Мужчина, Флиртующий, Sci-Fi', ['romance', 'scifi', 'drama']), ['romance', 'scifi'], 'interests match old aliases');
  check(onboarding.hasOnboardingSignals({ ...prefs, style: 'any', interests: [], gender: null }) === false, '"both styles" alone is not a signal');
  const tags = load(join(root, 'src/lib/characterTags.ts'));
  for (const interest of onboarding.ONBOARDING_INTERESTS) for (const tag of interest.tags) check(tags.ALL_CHARACTER_TAGS.includes(tag), `interest tag is canonical: ${tag}`);
  const art = load(join(root, 'src/lib/characterArtStyle.ts'));
  equal(art.guessArtStyle('Аниме', 'photo'), 'anime', 'tag decides before the prompt');
  equal(art.guessArtStyle(null, 'Anime illustration, cel shading'), 'anime', 'anime prompt');
  equal(art.guessArtStyle(null, 'Фотореалистичный портрет'), 'realistic', 'realistic prompt');
  equal(art.guessArtStyle(null, 'anime style photo'), null, 'contradictory prompt stays unknown');
  equal(art.guessArtStyle(null, null), null, 'silent card stays unknown');
  const fields = load(join(root, 'src/lib/characterFields.ts'));
  equal(fields.parseCharacterBody({ name: 'x', artStyle: 'anime' }).artStyle, 'anime', 'editor saves a valid style');
  equal(fields.parseCharacterBody({ name: 'x', artStyle: 'watercolor' }).artStyle, null, 'editor rejects unknown style');

  await pg.initialise(); await pg.start(); await pg.createDatabase('nv_onboarding');
  const schema = join(directory, 'schema.prisma');
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace(/Unsupported\("vector\(\d+\)"\)/g, 'Bytes'));
  const pushed = spawnSync(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', schema],
    { cwd: directory, env, encoding: 'utf8', timeout: 90000, windowsHide: true });
  if (pushed.status !== 0) throw new Error(`Private schema failed: ${pushed.stderr || pushed.stdout}`);
  const owner = await db.user.create({ data: { email: 'owner@example.test' } });
  const veteran = await db.user.create({ data: { email: 'veteran@example.test' } });
  const newcomer = await db.user.create({ data: { email: 'newcomer@example.test' } });
  const old = new Date('2026-01-01T00:00:00Z');
  const card = (id, extra) => ({ id, slug: id, name: id, name_en: id, userId: owner.id, isPublic: true, imageUrl: AVATAR,
    greeting: `*улыбается* Привет от ${id}`, descriptionCard: `Карточка ${id}`, totalMessages: 10, updatedAt: old, ...extra });
  const cards = [
    // Popularity gaps exceed the daily jitter (0.35), so the expected order holds on any date.
    card('anime-romance-top', { tags: 'Романтика, Аниме, Женский персонаж', totalMessages: 3000 }),
    card('anime-romance-low', { tags: 'Романтика, Флиртующий', artStyle: 'anime', totalMessages: 0, greeting: null }),
    card('anime-fantasy', { tags: 'Фэнтези, Эльф', artStyle: 'anime', totalMessages: 40 }),
    card('anime-male-romance', { tags: 'Романтика, Мужской персонаж', artStyle: 'anime', totalMessages: 20 }),
    card('real-romance', { tags: 'Романтика, Драма', artStyle: 'realistic', totalMessages: 70000 }),
    card('unknown-romance', { tags: 'Романтика', totalMessages: 30 }),
    card('anime-comedy-popular', { tags: 'Комедия', artStyle: 'anime', totalMessages: 70000 }),
    card('warned-romance', { tags: 'Романтика, Аниме', moderationStatus: 'warning', totalMessages: 99999 }),
    card('no-avatar-romance', { tags: 'Романтика, Аниме', imageUrl: null, totalMessages: 99999 }),
    card('private-romance', { tags: 'Романтика, Аниме', isPublic: false, totalMessages: 99999, greeting: 'PRIVATE_SENTINEL' }),
  ];
  for (const data of cards) await db.character.create({ data });
  await db.message.create({ data: { userId: veteran.id, characterId: 'real-romance', role: 'user', content: 'hi' } });

  const { getOnboardingPicks, rankOnboardingCandidates } = load(join(root, 'src/lib/onboardingPicks.ts'));
  const anime = await getOnboardingPicks({ style: 'anime', interests: ['romance'], gender: null, page: 0 });
  const ids = anime.characters.map(item => item.id);
  equal(ids, ['anime-romance-top', 'anime-male-romance', 'anime-romance-low'], 'classified anime romance comes first, by popularity');
  check(!ids.includes('real-romance'), 'a realistic card never appears for anime, however popular');
  equal(anime.total, 4, 'counter counts anime + unclassified romance cards only');
  const second = await getOnboardingPicks({ style: 'anime', interests: ['romance'], gender: null, page: 1 });
  equal(second.characters[0].id, 'unknown-romance', 'unclassified card follows the classified ones');
  check(second.characters.some(item => item.fallback && item.id === 'anime-comedy-popular'), 'popular anime card fills the trio and is marked');
  check(second.characters.every(item => item.id !== 'real-romance'), 'fallback respects the style too');
  for (const page of [0, 1, 2, 3]) {
    const result = await getOnboardingPicks({ style: 'anime', interests: ['romance'], gender: null, page });
    for (const hidden of ['warned-romance', 'no-avatar-romance', 'private-romance']) check(!result.characters.some(item => item.id === hidden), `${hidden} never offered (page ${page})`);
    check(result.characters.length > 0 && result.characters.length <= 3, `page ${page} has 1–3 cards`);
    check(!JSON.stringify(result).includes('PRIVATE_SENTINEL') && !JSON.stringify(result).includes('data:image'), 'no private text and no image data in the payload');
  }
  equal((await getOnboardingPicks({ style: 'anime', interests: ['romance'], gender: null, page: 2 })).characters.map(i => i.id), ids, 'paging past the end wraps around');
  const female = await getOnboardingPicks({ style: 'anime', interests: ['romance'], gender: 'female', page: 0 });
  check(female.characters.findIndex(item => item.id === 'anime-male-romance') === -1, 'female preference pushes male-tagged cards out of the first trio');
  const both = await getOnboardingPicks({ style: 'any', interests: ['romance'], gender: null, page: 0 });
  check(both.characters.some(item => item.id === 'real-romance'), '"both styles" includes realistic matches');
  const top = anime.characters[0];
  equal(top.matched, ['romance'], 'card says which interest matched');
  equal(top.greeting, '*улыбается* Привет от anime-romance-top', 'greeting snippet is passed through for italics');
  check(top.avatarUrl.startsWith('/api/characters/anime-romance-top/avatar'), 'avatar comes from the existing avatar route');
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, slug: `d${i}`, name: `d${i}`, name_en: null, descriptionCard: null, descriptionCard_en: null,
    description: null, description_en: null, greeting: null, greeting_en: null, artStyle: 'anime', totalMessages: 100 - i, createdAt: old, updatedAt: old,
    tags: i < 6 ? 'Романтика' : 'Фэнтези' }));
  const trio = rankOnboardingCandidates(many, { style: 'anime', interests: ['romance', 'fantasy'], gender: null }, 'seed').ordered.slice(0, 3);
  check(trio.some(item => item.matched[0] === 'fantasy'), 'a two-interest trio is not all one interest');

  const { GET } = load(join(root, 'src/app/api/onboarding/picks/route.ts'));
  const get = async query => { const response = await GET(Object.assign(new Request(`http://localhost/api/onboarding/picks?${query}`), { nextUrl: new URL(`http://localhost/api/onboarding/picks?${query}`) }));
    return { status: response.status, headers: response.headers, body: await response.json() }; };
  const counted = await get('style=anime&interests=romance&count=1');
  equal(counted.body, { total: 4 }, 'count-only response carries just the number');
  check(counted.headers.get('cache-control')?.includes('no-store'), 'picks are not cached');
  equal((await get('style=anime&interests=romance,hacking&page=-4')).body.characters.map(i => i.id), ids, 'bad page and interest are sanitized');

  const { getCharacterRecommendationOrder } = load(join(root, 'src/lib/characterRecommendations.ts'));
  const publicWhere = { isPublic: true, slug: { not: null } };
  const cold = await getCharacterRecommendationOrder(publicWhere, null, new Date());
  const warm = await getCharacterRecommendationOrder(publicWhere, null, new Date(), { status: 'completed', style: 'anime', interests: ['romance'], gender: null });
  equal(cold.mode, 'discovery', 'guest without answers stays in discovery');
  equal(warm.mode, 'personalized', 'answers personalize "for you"');
  check(warm.ids.indexOf('anime-romance-top') < warm.ids.indexOf('real-romance'), 'answers lift anime romance above realistic romance');
  // The catalog's genre-diversity rule still mixes other genres in after a few romance cards.
  const animeRomance = ['anime-romance-top', 'anime-romance-low', 'anime-male-romance', 'warned-romance', 'no-avatar-romance'];
  check(warm.ids.slice(0, 3).every(id => animeRomance.includes(id)), 'answers put anime romance on top of "for you"');
  check(!animeRomance.includes(cold.ids[1]) || cold.ids[0] !== warm.ids[0], 'without answers the order is different');
  const { getPublicCatalog } = load(join(root, 'src/lib/publicCatalog.ts'));
  request.cookie = '1.completed.anime.romance.-';
  const ssr = await getPublicCatalog('for-you', 1, '');
  equal(ssr.meta.recommendationMode, 'personalized', 'SSR catalog reads the answers from the cookie');
  equal(ssr.data.map(row => row.id), warm.ids.slice(0, ssr.data.length), 'SSR "for you" follows the answers');
  request.cookie = null;

  const server_ = load(join(root, 'src/lib/onboardingServer.ts'));
  process.env.ONBOARDING_ENABLED = '';
  check(await server_.shouldShowOnboarding(null, null) === false, 'flag off: never shown');
  process.env.ONBOARDING_ENABLED = 'true';
  check(await server_.shouldShowOnboarding(null, null), 'first visit of a guest: shown');
  check(await server_.shouldShowOnboarding(null, prefs) === false, 'saved answers: not shown again');
  check(await server_.shouldShowOnboarding(newcomer.id, null), 'signed-in user without messages: shown');
  check(await server_.shouldShowOnboarding(veteran.id, null) === false, 'user who already chatted: not shown');
  request.userAgent = 'Mozilla/5.0 (compatible; YandexBot/3.0)';
  check(await server_.shouldShowOnboarding(null, null) === false, 'crawlers get the plain catalog');
  request.userAgent = 'Mozilla/5.0 Synthetic';
  request.cookie = '1.skipped.-.-.-';
  equal(await server_.readOnboardingPrefs(), { status: 'skipped', style: null, interests: [], gender: null }, 'skip cookie is read back');
  request.cookie = null;

  const admin = load(join(root, 'src/app/api/admin/character-art-style/route.ts'));
  const post = async (body, secret = 'synthetic_admin_secret') => {
    const response = await admin.POST(new Request('http://localhost/api/admin/character-art-style', { method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-admin-secret': secret } : {}) }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  equal((await post({}, null)).status, 401, 'admin backfill requires the secret');
  const dry = await post({ mode: 'heuristic', limit: 40 });
  check(dry.body.dryRun && dry.body.saved === 0, 'dry run is the default and writes nothing');
  equal((await db.character.findUnique({ where: { id: 'anime-romance-top' } })).artStyle, null, 'dry run left the column empty');
  const wet = await post({ mode: 'heuristic', dryRun: false, limit: 40 });
  check(wet.body.saved >= 1, 'real run saves guesses');
  const saved = await db.character.findUnique({ where: { id: 'anime-romance-top' } });
  equal(saved.artStyle, 'anime', 'tag-based guess stored');
  equal(saved.updatedAt.toISOString(), old.toISOString(), 'backfill does not change updatedAt (avatar cache key)');
  equal((await db.character.findUnique({ where: { id: 'real-romance' } })).artStyle, 'realistic', 'existing style untouched');
  equal((await db.character.findUnique({ where: { id: 'unknown-romance' } })).artStyle, null, 'unknown stays unknown instead of a guess');
  equal((await db.character.findUnique({ where: { id: 'private-romance' } })).artStyle, null, 'private cards are not touched');

  if (process.argv.includes('--browser')) {
    const appPort = await freePort(), base = `http://127.0.0.1:${appPort}`;
    Object.assign(env, { NEXTAUTH_URL: base, NEXT_PUBLIC_APP_URL: base });
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(appPort)], { env, stdio: 'ignore', windowsHide: true });
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if (server.exitCode !== null) throw new Error('Local Next server exited');
      try { ready = (await fetch(base + '/robots.txt')).ok; } catch {}
      if (ready) break;
      await new Promise(done => setTimeout(done, 500));
    }
    check(ready, 'isolated production build starts');
    const html = await (await fetch(base + '/ru')).text();
    check(html.includes('Какие персонажи вам ближе?'), 'first visit HTML already contains the picker (no catalog flash)');
    const botHtml = await (await fetch(base + '/ru', { headers: { 'user-agent': 'Googlebot/2.1' } })).text();
    check(!botHtml.includes('Какие персонажи вам ближе?') && botHtml.includes('data-character-list-scroll'), 'crawler HTML is the plain catalog');
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const errors = [];
    const newPage = async (viewport, cookie) => {
      const context = await browser.newContext({ viewport });
      if (cookie) await context.addCookies([{ name: 'nv_onboarding', value: cookie, url: base }]);
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      return { context, page };
    };
    const cookieOf = async context => (await context.cookies(base)).find(item => item.name === 'nv_onboarding')?.value;
    const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 860 }]) {
      const { context, page } = await newPage(viewport);
      await page.goto(base + '/ru');
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('heading', { name: 'Какие персонажи вам ближе?' }).waitFor();
      check(await noOverflow(page), `step 1 fits ${viewport.width}px`);
      await dialog.getByRole('button', { name: /^Аниме/ }).click();
      await dialog.getByRole('heading', { name: 'Какие истории вам интересны?' }).waitFor();
      check(await dialog.getByRole('button', { name: 'Показать персонажей' }).isDisabled(), 'results need at least one interest');
      await dialog.getByRole('button', { name: /^Романтика/ }).click();
      await dialog.getByText('Подходит 4 персонажа · выбрано 1 из 3').waitFor();
      check(true, `live counter with Russian plural (${viewport.width}px)`);
      for (const name of [/^Фэнтези и магия/, /^Драма/]) await dialog.getByRole('button', { name }).click();
      await dialog.getByRole('button', { name: /^Комедия/ }).click();
      await dialog.getByText('Можно выбрать до трёх. Снимите один, чтобы выбрать другой.').waitFor();
      check(await dialog.getByRole('button', { name: /^Комедия/ }).getAttribute('aria-pressed') === 'false', 'a fourth interest is refused');
      for (const name of [/^Фэнтези и магия/, /^Драма/]) await dialog.getByRole('button', { name }).click();
      check(await noOverflow(page), `step 2 fits ${viewport.width}px`);
      await dialog.getByRole('button', { name: 'Показать персонажей' }).click();
      await dialog.getByRole('button', { name: 'Начать разговор' }).first().waitFor();
      const names = await dialog.locator('article h3').allTextContents();
      equal(names[0], 'anime-romance-top', 'first pick is the best anime romance card');
      check(!names.includes('real-romance'), 'browser picks respect the style');
      check(await dialog.getByText('Совпадает: Романтика').first().isVisible(), 'match reason shown');
      check(await dialog.locator('article em').first().textContent() === 'улыбается', 'greeting action rendered in italics, not as markup');
      check(await noOverflow(page), `step 3 fits ${viewport.width}px`);
      await dialog.getByRole('button', { name: 'Показать других' }).click();
      await dialog.getByRole('button', { name: 'Начать разговор' }).first().waitFor();
      check((await dialog.locator('article h3').allTextContents()).join() !== names.join(), '"show others" brings a different trio');
      await dialog.getByRole('button', { name: 'Назад' }).click();
      await dialog.getByRole('heading', { name: 'Какие истории вам интересны?' }).waitFor();
      check(await dialog.getByRole('button', { name: /^Романтика/ }).getAttribute('aria-pressed') === 'true', 'back keeps the answers');
      await dialog.getByRole('button', { name: 'Показать персонажей' }).click();
      await dialog.getByRole('button', { name: 'Начать разговор' }).first().click();
      await page.waitForURL(/\/ru\/chat\/anime-romance-top/);
      equal(await cookieOf(context), '1.completed.anime.romance.-', 'starting a chat saves the answers');
      await page.goto(base + '/ru');
      await page.locator('[data-character-list-scroll]').waitFor();
      check(await page.getByRole('dialog').count() === 0, 'a completed picker is not shown again');
      await context.close();
    }

    const skipper = await newPage({ width: 390, height: 844 });
    await skipper.page.goto(base + '/ru');
    await skipper.page.getByRole('dialog').getByRole('button', { name: 'Пропустить' }).click();
    await skipper.page.getByRole('dialog').waitFor({ state: 'detached' });
    equal(await cookieOf(skipper.context), '1.skipped.-.-.-', 'skip on step 1 is remembered');
    check(await skipper.page.evaluate(() => document.body.style.overflow === ''), 'page scroll is unlocked after closing');
    await skipper.page.getByRole('button', { name: 'Подобрать персонажа' }).click();
    await skipper.page.getByRole('dialog').getByRole('heading', { name: 'Какие персонажи вам ближе?' }).waitFor();
    check(true, '"find a character" reopens the picker');
    await skipper.page.keyboard.press('Escape');
    await skipper.page.getByRole('dialog').waitFor({ state: 'detached' });
    check(true, 'Escape closes the picker');
    await skipper.context.close();

    const partial = await newPage({ width: 390, height: 844 });
    await partial.page.goto(base + '/ru');
    const partialDialog = partial.page.getByRole('dialog');
    await partialDialog.getByRole('button', { name: /^Аниме/ }).click();
    await partialDialog.getByRole('button', { name: /^Романтика/ }).click();
    await partialDialog.getByRole('button', { name: 'Пропустить' }).click();
    await partial.page.waitForURL(/sort=for-you/);
    equal(await cookieOf(partial.context), '1.skipped.anime.romance.-', 'skip on step 2 keeps what was chosen');
    await partial.page.getByText('Учитываем ваш выбор:').waitFor();
    const firstCard = partial.page.locator('main[data-character-list-scroll] a[href*="/character/"]').first();
    const firstHref = await firstCard.getAttribute('href');
    check(animeRomance.some(id => firstHref.endsWith(`/${id}`)), `catalog "for you" follows the partial answers (${firstHref})`);
    await partial.page.getByRole('button', { name: 'Убрать «Аниме»' }).click();
    await partial.page.waitForFunction(() => document.cookie.includes('nv_onboarding=1.skipped.-.romance.-'));
    check(true, 'removing a chip updates the saved answers');
    check(await partial.page.getByRole('button', { name: 'Убрать «Аниме»' }).count() === 0, 'removed chip disappears');
    check(await noOverflow(partial.page), 'catalog with chips fits the phone');
    await partial.context.close();
    equal(errors, [], 'no browser hydration/runtime errors');
  }
  console.log(`Onboarding: ${checks} parsing/ranking/Prisma/handler${process.argv.includes('--browser') ? '/browser' : ''} checks passed`);
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
