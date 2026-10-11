// Screenshots of the local production build on a private disposable PostgreSQL cluster.
// Same isolation as scripts/verify-seo-runtime.mjs: no .env credentials, external requests aborted.
// Usage: npm run build && node docs/style-audit-2026-10-11/preview-after.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { encode } from 'next-auth/jwt';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const here = resolve('docs/style-audit-2026-10-11');
const out = process.env['STYLE_PREVIEW_OUTPUT'] || join(here, 'after');
mkdirSync(out, { recursive: true });
const runtime = process.env['GUEST_TEST_RUNTIME'] || join(tmpdir(), 'nv-p1-isolated-runtime');
const EmbeddedPostgres = require(join(resolve(runtime), 'node_modules/embedded-postgres/dist/index.js')).default;

const freePort = () => new Promise((ok, fail) => {
  const server = createServer(); server.on('error', fail);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => ok(port)); });
});
const port = await freePort();
const appPort = await freePort();
const directory = mkdtempSync(join(tmpdir(), 'nv-style-'));
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_style_preview',
  port, persistent: true, initdbFlags: ['--encoding=UTF8'], onLog() {} });
const databaseUrl = `postgresql://postgres:synthetic_style_preview@127.0.0.1:${port}/nv_style_preview`;
const base = `http://127.0.0.1:${appPort}`;
const env = { ...process.env };
for (const key of Object.keys(env)) if (/SECRET|TOKEN|PASSWORD|API.*KEY|DATABASE_URL|DIRECT_URL/i.test(key)) env[key] = '';
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (existsSync(file)) for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = '';
}
Object.assign(env, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl,
  NEXTAUTH_SECRET: 'synthetic_style_session', NEXTAUTH_URL: base, NEXT_PUBLIC_APP_URL: base });
const db = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });

// Keep this preview reproducible without the owner's separate paid-test artifacts.
const imageDir = resolve('public/images/roleplay-modes-v1');
const images = readdirSync(imageDir).filter(name => name.endsWith('.png'))
  .map(name => `data:image/png;base64,${readFileSync(join(imageDir, name)).toString('base64')}`);
assert.ok(images.length, 'local preview images exist');
const { cards } = JSON.parse(readFileSync(join(here, 'cards.json'), 'utf8'));
const tags = ['Фэнтези, Исторический', 'Фэнтези, RPG', 'Аниме, Романтика', 'Реалистичный, Симулятор', 'Фэнтези, Приключение',
  'Мистика, Магия', 'Sci-Fi, Экшен', 'Sci-Fi, Драма', 'Фэнтези, Приключение', 'Реалистичный, Офис', 'Аниме, Магия', 'Аниме, Комедия, Цуцере'];

let child, browser;
try {
  await pg.initialise(); await pg.start(); await pg.createDatabase('nv_style_preview');
  const schema = join(directory, 'schema.prisma');
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace('Unsupported("vector(1536)")', 'Bytes'));
  const setup = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', schema],
    { env, encoding: 'utf8', timeout: 90000, windowsHide: true });
  if (setup.status !== 0) throw new Error('Private preview schema setup failed');
  const owner = await db.user.create({ data: { email: 'style-owner@example.test', name: 'Faldee' } });
  for (let round = 0; round < 3; round++) {
    for (const [index, card] of cards.entries()) {
      const n = round * cards.length + index;
      await db.character.create({ data: {
        id: `style-${n}`, slug: `${card.href.split('/').pop()}-${round}`, name: card.name,
        descriptionCard: card.description, imageUrl: images[n % images.length], tags: tags[index],
        userId: owner.id, isPublic: true, totalMessages: Number(card.messages.replace(/\D/g, '')) - round * 600,
      } });
    }
  }

  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(appPort)],
    { env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/robots.txt')).status === 200) break; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  const sessionToken = await encode({ token: { id: owner.id, sub: owner.id, email: owner.email, name: owner.name },
    secret: env.NEXTAUTH_SECRET, maxAge: 3600 });

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const shots = [
    ['desktop', { width: 1440, height: 900 }, false],
    ['tablet', { width: 900, height: 1000 }, false],
    ['mobile', { width: 390, height: 844 }, true],
    ['narrow', { width: 320, height: 740 }, true],
  ];
  const routes = [
    ['home', '/ru?sort=top', false],
    ['home-user', '/ru?sort=top', true],
    ['coins', '/ru/coins', false],
    ['login', '/ru/login', false],
    ['subscription', '/ru/subscription', false],
    ['create', '/ru/create', false],
    ['character', `/ru/character/${cards[0].href.split('/').pop()}-0`, false],
    ['chat', '/ru/chat/style-2', false],
    ['home-en', '/en?sort=top', false],
  ];
  const errors = [];
  for (const [device, viewport, mobile] of shots) {
    for (const [name, route, signedIn] of routes) {
      if (device === 'tablet' && name !== 'home') continue;
      if (device === 'narrow' && !['home', 'login', 'coins'].includes(name)) continue;
      const context = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, locale: 'ru-RU' });
      await context.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.abort());
      if (signedIn) await context.addCookies([{ name: 'next-auth.session-token', value: sessionToken, url: base }]);
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(`${device}/${name}: ${e.message}`));
      await page.goto(base + route, { waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(out, `${device}-${name}.png`) });
      if (['home', 'coins'].includes(name)) await page.screenshot({ path: join(out, `${device}-${name}-full.png`), fullPage: true });
      const metrics = await page.evaluate(() => {
        // Same WCAG check as capture.cjs (used for the live-site baseline).
        const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
        const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const bgOf = el => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage !== 'none') return null; const c = parse(s.backgroundColor); if (c && c.a > 0.9) return c; } return parse(getComputedStyle(document.body).backgroundColor); };
        const low = [];
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
          const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) continue;
          const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').trim();
          const fg = parse(s.color), bg = bgOf(el);
          if (!text || !fg || !bg) continue;
          const mix = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
          const ratio = (Math.max(lum(mix), lum(bg)) + 0.05) / (Math.min(lum(mix), lum(bg)) + 0.05);
          const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700);
          if (ratio < (large ? 3 : 4.5)) low.push(`${text.slice(0, 30)} ${ratio.toFixed(2)}`);
        }
        const nav = document.querySelector('nav ul.grid')?.closest('nav');
        return {
          overflowX: document.documentElement.scrollWidth > innerWidth,
          bottomNav: !!nav && getComputedStyle(nav).display !== 'none',
          h1: document.querySelector('h1')?.innerText.replace(/\s+/g, ' ').trim(),
          lowContrast: low.length, lowContrastSample: low.slice(0, 4),
        };
      });
      console.log(device, name, JSON.stringify(metrics));
      assert.equal(metrics.overflowX, false, `${device}/${name}: no horizontal overflow`);
      assert.equal(metrics.lowContrast, 0, `${device}/${name}: checked solid backgrounds pass contrast`);
      assert.equal(metrics.bottomNav, mobile && name !== 'chat', `${device}/${name}: bottom navigation visibility`);
      await context.close();
    }
  }
  console.log('page errors:', errors.length ? errors : 'none');
  assert.equal(errors.length, 0, 'no browser runtime errors');
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(r => child.once('exit', r));
    child.kill();
    await ended;
  }
  await db.$disconnect();
  const native = join(resolve(runtime), 'node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe');
  if (existsSync(native)) spawnSync(native, ['-D', join(directory, 'db'), 'stop', '-m', 'fast', '-w'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
}
