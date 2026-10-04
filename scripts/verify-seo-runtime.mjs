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
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace('Unsupported("vector(1536)")', 'Bytes'));
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
  } });
  await db.character.create({ data: { id: 'seo-private-id', slug: 'seo-private-slug',
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
    for (const path of [`/${locale}`, `/${locale}/gallery`]) {
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
  const secondPage = await request('/ru/gallery?page=2');
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
  await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('new');
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
