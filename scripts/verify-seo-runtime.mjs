// Real Next HTTP/browser checks on a private disposable PostgreSQL cluster.
// Never uses .env credentials, production URLs or the live Metrika counter.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { encode } from 'next-auth/jwt';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const runtime = process.env['GUEST_TEST_RUNTIME'] || join(tmpdir(), 'nv-p1-isolated-runtime');
const modulePath = join(resolve(runtime), 'node_modules/embedded-postgres/dist/index.js');
if (!existsSync(modulePath)) throw new Error('Set GUEST_TEST_RUNTIME to an isolated embedded-postgres installation');
const EmbeddedPostgres = require(modulePath).default;
async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); });
  });
}
const port = await freePort();
const appPort = await freePort();
const directory = mkdtempSync(join(tmpdir(), 'nv-seo-'));
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres',
  password: 'synthetic_seo_test', port, persistent: true, initdbFlags: ['--encoding=UTF8'], onLog() {} });
const databaseUrl = `postgresql://postgres:synthetic_seo_test@127.0.0.1:${port}/nv_seo_test`;
const base = `http://127.0.0.1:${appPort}`;
const env = { ...process.env };
for (const key of Object.keys(env)) if (/SECRET|TOKEN|PASSWORD|API.*KEY|DATABASE_URL|DIRECT_URL/i.test(key)) env[key] = '';
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (existsSync(file)) for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = '';
}
Object.assign(env, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', DATABASE_URL: databaseUrl,
  DIRECT_URL: databaseUrl, NEXTAUTH_SECRET: 'synthetic_seo_session', NEXTAUTH_URL: base, NEXT_PUBLIC_APP_URL: base });
const db = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
let child, browser, checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
async function request(path, options = {}) {
  const response = await fetch(base + path, { redirect: 'manual', ...options });
  return { status: response.status, headers: response.headers, body: (await response.text()).replaceAll('&amp;', '&') };
}
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('nv_seo_test');
  const schema = join(directory, 'schema.prisma');
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace(/Unsupported\("vector\(\d+\)"\)/g, 'Bytes'));
  const setup = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', schema], { env, encoding: 'utf8', timeout: 90000, windowsHide: true });
  if (setup.status !== 0) throw new Error('Private SEO schema setup failed');
  const owner = await db.user.create({ data: { email: 'seo-owner@example.test', name: 'SEO author' } });
  const outsider = await db.user.create({ data: { email: 'seo-other@example.test' } });
  const updatedAt = new Date('2026-10-01T12:00:00Z');
  for (let i = 1; i <= 26; i++) await db.character.create({ data: {
    id: `seo-public-${i}`, slug: `seo-hero-${i}`, name: `Герой SEO ${i}`, name_en: `SEO hero ${i}`,
    descriptionCard: `Публичное описание ${i}`, descriptionCard_en: `Public description ${i}`,
    publicMemory: 'Открытая история', publicMemory_en: 'Public story',
    privateMemory: 'PRIVATE_MEMORY_SENTINEL', systemPrompt: 'SYSTEM_PROMPT_SENTINEL',
    moderationReason: 'MODERATION_SENTINEL', userId: owner.id, isPublic: true,
    totalMessages: 100 - i, updatedAt,
    // Genres: 25 romance (two pages of 24), comedy thin with 2 (one stored under the English alias).
    tags: i === 25 ? 'Comedy' : i === 13 ? 'Романтика, Комедия' : 'Романтика, Аниме',
  } });
  await db.character.create({ data: { id: 'seo-private-id', slug: 'seo-private-slug', tags: 'Комедия',
    name: 'PRIVATE_NAME_SENTINEL', descriptionCard: 'Private owner card', isPublic: false,
    userId: owner.id, privateMemory: 'PRIVATE_MEMORY_SENTINEL', systemPrompt: 'SYSTEM_PROMPT_SENTINEL' } });
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(appPort)], { env, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('Isolated Next server exited');
    try { ready = (await request('/robots.txt')).status === 200; } catch {}
    if (ready) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  check(ready, 'isolated Next ready');
  const ownerCookie = `next-auth.session-token=${await encode({ token: { id: owner.id, sub: owner.id, email: owner.email }, secret: env.NEXTAUTH_SECRET, maxAge: 3600 })}`;
  const outsiderCookie = `next-auth.session-token=${await encode({ token: { id: outsider.id, sub: outsider.id }, secret: env.NEXTAUTH_SECRET, maxAge: 3600 })}`;
  for (const ua of ['Mozilla/5.0 Chrome/134.0', 'YandexBot']) {
    for (const slug of ['does-not-exist', 'seo-private-slug', 'seo-private-id']) {
      const response = await request(`/ru/character/${slug}`, { headers: { 'User-Agent': ua } });
      check(response.status === 404, `${ua}: ${slug} is HTTP 404`);
      check(response.body.includes('noindex'), `${slug}: noindex`);
      check(!response.body.includes('PRIVATE_NAME_SENTINEL'), `${slug}: hidden data absent`);
    }
    const redirect = await request('/en/character/seo-public-1', { headers: { 'User-Agent': ua } });
    check(redirect.status === 308 && redirect.headers.get('location') === '/en/character/seo-hero-1', 'legacy id localized canonical redirect');
  }
  const other = await request('/ru/character/seo-private-slug', { headers: { Cookie: outsiderCookie } });
  check(other.status === 404, 'other account cannot see private character');
  const privatePage = await request('/ru/character/seo-private-slug', { headers: { Cookie: ownerCookie } });
  check(privatePage.status === 200 && privatePage.body.includes('PRIVATE_NAME_SENTINEL'), 'owner still sees own character');
  check(privatePage.body.includes('noindex'), 'owner private page noindex');
  for (const locale of ['ru', 'en']) {
    const character = await request(`/${locale}/character/seo-hero-1`);
    check(character.status === 200 && /<h1[^>]*>/.test(character.body), `${locale}: character SSR H1`);
    check(character.body.includes(locale === 'ru' ? 'Публичное описание 1' : 'Public description 1'), `${locale}: localized SSR description`);
    check(character.body.includes(`rel="canonical" href="https://newvers.ai/${locale}/character/seo-hero-1"`), `${locale}: canonical`);
    for (const sentinel of ['PRIVATE_MEMORY_SENTINEL', 'SYSTEM_PROMPT_SENTINEL', 'MODERATION_SENTINEL']) check(!character.body.includes(sentinel), `public payload omits ${sentinel}`);
    const gallery = await request(`/${locale}/gallery?page=2`);
    check(gallery.status === 308 && gallery.headers.get('location')?.endsWith(`/${locale}?page=2`), `/${locale}/gallery: permanent redirect to catalog`);
    for (const path of [`/${locale}`]) {
      const catalog = await request(path);
      check(catalog.status === 200 && /<h1[^>]*>/.test(catalog.body), `${path}: SSR H1`);
      check(catalog.body.includes(`href="/${locale}/character/seo-hero-1"`), `${path}: SSR public links`);
      check(catalog.body.includes(locale === 'ru' ? 'Герой SEO 1' : 'SEO hero 1'), `${path}: localized SSR cards`);
      check(!catalog.body.includes('PRIVATE_NAME_SENTINEL') && !catalog.body.includes('PRIVATE_MEMORY_SENTINEL'), `${path}: private data absent`);
      check(/href="[^\"]*page=2/.test(catalog.body), `${path}: crawlable pagination`);
    }
  }
  await Promise.all(['ru', 'en', 'ru', 'en'].map(async locale => {
    const response = await request(`/${locale}/character/seo-hero-1`);
    check(response.body.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1] === (locale === 'ru' ? 'Герой SEO 1' : 'SEO hero 1'), 'concurrent requests keep their locale');
  }));
  const secondPage = await request('/ru?page=2');
  check(secondPage.body.includes('href="/ru/character/seo-hero-25"') && !secondPage.body.includes('href="/ru/character/seo-hero-1"'), 'server pagination uses requested page');
  const search = await request('/en?q=SEO%20hero%2026');
  check(search.body.includes('href="/en/character/seo-hero-26"') && !search.body.includes('href="/en/character/seo-hero-1"'), 'server q search uses English fields');
  const tracked = await request('/ru?sort=top&etext=test&ybaip=test');
  check(tracked.body.includes('rel="canonical" href="https://newvers.ai/ru"'), 'tracking canonical clean');
  for (const path of ['/ru/pricing', '/en/pricing', '/ru/coins', '/ru/support']) {
    const response = await request(path);
    check(response.status === 200 && response.body.includes(`rel="canonical" href="https://newvers.ai${path}"`), `${path}: canonical retained`);
  }
  for (const path of ['/ru/login', '/ru/profile', '/ru/chats', '/ru/favorites', '/ru/chat/seo-public-1']) {
    const response = await request(path);
    check(response.status === 200 && response.body.includes('noindex, follow'), `${path}: service noindex retained`);
    check(!response.body.includes('rel="canonical"'), `${path}: no homepage canonical inheritance`);
  }
  const sitemap = await request('/sitemap.xml');
  check(sitemap.status === 200 && sitemap.headers.get('content-type').includes('xml'), 'sitemap successful XML');
  check(sitemap.body.includes('/ru/character/seo-hero-1</loc>') && sitemap.body.includes('/en/character/seo-hero-1</loc>'), 'sitemap public localized URLs');
  check(!sitemap.body.includes('seo-private') && !sitemap.body.includes('/profile</loc>'), 'sitemap excludes private/services');
  check(sitemap.body.includes(updatedAt.toISOString()), 'sitemap real updatedAt');
  const staticEntry = sitemap.body.match(/<url>\s*<loc>https:\/\/newvers.ai\/ru<\/loc>(.*?)<\/url>/s)?.[1];
  check(staticEntry !== undefined && !staticEntry.includes('<lastmod>'), 'static entries have no artificial lastmod');

  // Genre landing pages.
  const robotsMeta = body => body.match(/<meta name="robots" content="([^"]+)"/)?.[1];
  const hreflang = (body, lang) => body.match(new RegExp(`<link rel="alternate" hreflang="${lang}" href="([^"]+)"`, 'i'))?.[1];
  const h1 = body => body.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1];
  for (const locale of ['ru', 'en']) {
    const romance = await request(`/${locale}/genres/romance`);
    check(romance.status === 200, `${locale}/genres/romance: 200`);
    check(h1(romance.body) === (locale === 'ru' ? 'Романтические персонажи для ролевых игр с ИИ' : 'Romance characters for AI roleplay'), `${locale}/genres/romance: SSR H1`);
    check(romance.body.includes(`<title>${locale === 'ru' ? 'Романтические персонажи для ролевых игр с ИИ' : 'Romance characters for AI roleplay'} — NewVerse</title>`), `${locale}/genres/romance: title`);
    check(/<meta name="description" content="[^"]{60,160}"/.test(romance.body), `${locale}/genres/romance: description`);
    check(romance.body.includes(`rel="canonical" href="https://newvers.ai/${locale}/genres/romance"`), `${locale}/genres/romance: canonical`);
    check(hreflang(romance.body, 'ru') === 'https://newvers.ai/ru/genres/romance' && hreflang(romance.body, 'en') === 'https://newvers.ai/en/genres/romance', `${locale}/genres/romance: hreflang`);
    check(robotsMeta(romance.body) === 'index, follow', `${locale}/genres/romance: indexable (25 >= 8)`);
    check(/<meta property="og:image" content="https:\/\/newvers.ai\/api\/characters\/seo-public-1\/avatar/.test(romance.body), `${locale}/genres/romance: OG image is the top character avatar`);
    check(romance.body.includes(`href="/${locale}/character/seo-hero-1"`) && romance.body.includes(`href="/${locale}/character/seo-hero-24"`), `${locale}/genres/romance: SSR cards by popularity`);
    check(!romance.body.includes(`href="/${locale}/character/seo-hero-25"`) && !romance.body.includes(`href="/${locale}/character/seo-hero-26"`), `${locale}/genres/romance: other genres and page 2 absent`);
    check(romance.body.includes(`href="/${locale}/genres/romance?page=2"`), `${locale}/genres/romance: crawlable pagination`);
    check(romance.body.includes(`href="/${locale}/genres/comedy"`) && romance.body.includes(`href="/${locale}/genres"`), `${locale}/genres/romance: links to other genres and the hub`);
    const ld = [...romance.body.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(match => JSON.parse(match[1]));
    const graph = ld.flatMap(item => item['@graph'] ?? [item]);
    const list = graph.find(item => item['@type'] === 'ItemList');
    const crumbs = graph.find(item => item['@type'] === 'BreadcrumbList');
    check(graph.some(item => item['@type'] === 'CollectionPage' && item.url === `https://newvers.ai/${locale}/genres/romance`), `${locale}/genres/romance: CollectionPage JSON-LD`);
    check(list?.itemListElement.length === 24 && list.itemListElement[0].url === `https://newvers.ai/${locale}/character/seo-hero-1` && list.itemListElement[0].position === 1, `${locale}/genres/romance: ItemList of the page`);
    check(crumbs?.itemListElement.map(item => item.item).join() === `https://newvers.ai/${locale},https://newvers.ai/${locale}/genres,https://newvers.ai/${locale}/genres/romance`, `${locale}/genres/romance: BreadcrumbList home > genres > genre`);
    const page2 = await request(`/${locale}/genres/romance?page=2&utm_source=test`);
    check(page2.status === 200 && page2.body.includes(`href="/${locale}/character/seo-hero-26"`) && !page2.body.includes(`href="/${locale}/character/seo-hero-1"`), `${locale}/genres/romance?page=2: next page`);
    check(page2.body.includes(`rel="canonical" href="https://newvers.ai/${locale}/genres/romance?page=2"`) && robotsMeta(page2.body) === 'index, follow', `${locale}/genres/romance?page=2: self canonical, indexable`);
    check(/"position":25/.test(page2.body), `${locale}/genres/romance?page=2: ItemList continues numbering`);
    const page1 = await request(`/${locale}/genres/romance?page=1&etext=test`);
    check(page1.body.includes(`rel="canonical" href="https://newvers.ai/${locale}/genres/romance"`), `${locale}/genres/romance?page=1: canonical clean`);
    check((await request(`/${locale}/genres/romance?page=3`)).status === 404, `${locale}/genres/romance?page=3: empty page is 404`);
    const comedy = await request(`/${locale}/genres/comedy`);
    check(comedy.status === 200 && h1(comedy.body) === (locale === 'ru' ? 'Комедийные персонажи для ролевых игр с ИИ' : 'Comedy characters for AI roleplay'), `${locale}/genres/comedy: renders for users`);
    check(robotsMeta(comedy.body) === 'noindex, follow', `${locale}/genres/comedy: thin genre noindex,follow`);
    check(comedy.body.includes(`href="/${locale}/character/seo-hero-13"`) && comedy.body.includes(`href="/${locale}/character/seo-hero-25"`), `${locale}/genres/comedy: alias tag matched`);
    check(!comedy.body.includes('PRIVATE_NAME_SENTINEL'), `${locale}/genres/comedy: private characters absent`);
    const empty = await request(`/${locale}/genres/horror`);
    check(empty.status === 200 && robotsMeta(empty.body) === 'noindex, follow' && empty.body.includes(`href="/${locale}/create"`), `${locale}/genres/horror: empty genre renders noindex with a way out`);
    const unknown = await request(`/${locale}/genres/not-a-genre`);
    check(unknown.status === 404 && unknown.body.includes('noindex'), `${locale}/genres/not-a-genre: 404`);
    const hub = await request(`/${locale}/genres`);
    check(hub.status === 200 && hub.body.includes(`rel="canonical" href="https://newvers.ai/${locale}/genres"`) && robotsMeta(hub.body) === 'index, follow', `/${locale}/genres: indexable hub`);
    for (const id of ['fantasy', 'romance', 'anime', 'scifi', 'mystic', 'realistic', 'adventure', 'detective', 'everyday', 'cyberpunk', 'horror', 'comedy', 'drama']) {
      check(hub.body.includes(`href="/${locale}/genres/${id}"`), `/${locale}/genres: links ${id}`);
    }
    const home = await request(`/${locale}`);
    check(/<a[^>]+href="\/(?:ru|en)\/genres\/romance"[^>]*>/.test(home.body.split('<footer')[0]), `/${locale}: genre chips are crawlable links`);
    check(home.body.split('<footer')[1]?.includes(`href="/${locale}/genres/fantasy"`) && home.body.split('<footer')[1].includes(`href="/${locale}/genres"`), `/${locale}: footer genre block`);
    const character = await request(`/${locale}/character/seo-hero-1`);
    check(character.body.split('<footer')[0].includes(`href="/${locale}/genres/romance"`) && character.body.split('<footer')[0].includes(`href="/${locale}/genres/anime"`), `${locale}: character tags link to genre pages`);
  }
  check(sitemap.body.includes('/ru/genres/romance</loc>') && sitemap.body.includes('/en/genres/romance</loc>') && sitemap.body.includes('/ru/genres</loc>'), 'sitemap filled genres and hub');
  check(!sitemap.body.includes('/genres/comedy</loc>') && !sitemap.body.includes('/genres/horror</loc>') && !sitemap.body.includes('genres/romance?page'), 'sitemap excludes thin genres and pagination');
  check(sitemap.body.match(/<loc>https:\/\/newvers.ai\/ru\/genres\/romance<\/loc>\s*<lastmod>([^<]+)/)?.[1] === updatedAt.toISOString(), 'genre lastmod is its latest character');
  // Filling a thin genre flips it to indexable and into the sitemap with no code change.
  await db.character.updateMany({ where: { id: { in: [14, 15, 16, 17, 18, 19].map(i => `seo-public-${i}`) } }, data: { tags: 'Романтика, Комедия' } });
  const filled = await request('/ru/genres/comedy');
  check(robotsMeta(filled.body) === 'index, follow', 'comedy indexable at 8 public characters');
  const refreshed = await request('/sitemap.xml');
  check(refreshed.body.includes('/ru/genres/comedy</loc>') && refreshed.body.includes('/en/genres/comedy</loc>'), 'filled genre enters the sitemap');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  let page = await noJs.newPage();
  await page.goto(base + '/en/character/seo-hero-1');
  check(await page.locator('h1').innerText() === 'SEO hero 1', 'character content visible with JS disabled');
  await page.goto(base + '/en');
  check(await page.locator('a[href="/en/character/seo-hero-1"]:visible').count() === 1, 'catalog links visible with JS disabled');
  await noJs.close();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/en?sort=top');
  await page.locator('a[href="/en/character/seo-hero-1"]:visible').waitFor();
  check(await page.locator('h1').innerText() !== '', 'hydrated H1');
  await page.getByRole('link', { name: 'Page 2 of 2', exact: true }).click();
  await page.locator('a[href="/en/character/seo-hero-25"]:visible').waitFor();
  check(page.url().includes('page=2'), 'hydrated pagination updates URL');
  await page.locator('a[href="/en/character/seo-hero-25"]:visible').click();
  await page.locator('h1').filter({ hasText: 'SEO hero 25' }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('a[href="/en/character/seo-hero-25"]:visible').waitFor();
  check(page.url().includes('page=2'), 'return from character retains list page');
  await page.goto(base + '/en');
  const chip = page.getByRole('group', { name: 'Genres', exact: true }).getByRole('link', { name: 'Comedy', exact: true });
  check(await chip.getAttribute('href') === '/en/genres/comedy', 'home genre chip is a link to its page');
  await chip.click();
  await page.locator('a[href="/en/character/seo-hero-25"]:visible').waitFor();
  check(new URL(page.url()).pathname === '/en' && await page.locator('a[href="/en/character/seo-hero-1"]:visible').count() === 0, 'chip click still filters the catalog in place');
  await page.goto(base + '/en/genres/romance');
  await page.getByRole('link', { name: 'Page 2 of 2', exact: true }).click();
  await page.locator('a[href="/en/character/seo-hero-26"]:visible').waitFor();
  check(page.url().endsWith('/en/genres/romance?page=2'), 'genre pagination navigates to ?page=2');
  check(errors.length === 0, 'no browser hydration/runtime errors');
  await page.setViewportSize({ width: 1280, height: 900 });
  const desktopResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/characters' && url.searchParams.get('search') === 'SEO hero 26' && response.status() === 200;
  });
  await page.goto(base + '/en?q=SEO%20hero%2026&sort=top');
  await page.locator('a[href="/en/character/seo-hero-26"]:visible').waitFor();
  await desktopResponse;
  check(await page.locator('a[href="/en/character/seo-hero-26"]:visible').count() === 1, 'desktop refresh keeps English q search results');
  check(await page.locator('a[href="/en/character/seo-hero-1"]:visible').count() === 0, 'desktop refresh does not reset search');
  await page.getByPlaceholder('Search by name or tag...').fill('SEO hero 25');
  await page.getByRole('group', { name: 'Sort', exact: true }).getByRole('button', { name: 'New', exact: true }).click();
  await page.locator('a[href="/en/character/seo-hero-25"]:visible').waitFor();
  check(new URL(page.url()).searchParams.get('q') === 'SEO hero 25', 'sort navigation retains typed search in URL');
  check(await page.getByPlaceholder('Search by name or tag...').inputValue() === 'SEO hero 25', 'sort navigation retains search input');
  await context.close(); await browser.close(); browser = undefined;
  await db.$disconnect();
  await pg.stop();
  const failedSitemap = await request('/sitemap.xml');
  check(failedSitemap.status === 500, 'DB outage does not publish empty 200 sitemap');
  const failedCharacter = await request('/ru/character/seo-hero-1');
  check(failedCharacter.status === 500 && !failedCharacter.body.includes('synthetic_seo_test'), 'DB outage remains safe 500, not 404');
  console.log(`SEO runtime: ${checks} HTTP/DB/browser checks passed`);
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    // Attach before terminating; a signal exit has null exitCode even after exit.
    const ended = new Promise(resolveWait => child.once('exit', resolveWait));
    child.kill();
    await ended;
  }
  await db.$disconnect();
  // This native command targets only the exact private cluster created above.
  const native = join(resolve(runtime), 'node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe');
  if (existsSync(native)) spawnSync(native, ['-D', join(directory, 'db'), 'stop', '-m', 'fast', '-w'], { stdio: 'ignore', windowsHide: true });
}
