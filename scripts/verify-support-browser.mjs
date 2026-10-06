import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const port = await new Promise(done => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
const env = { ...process.env };
for (const key of Object.keys(env)) if (/SECRET|TOKEN|PASSWORD|API.*KEY|DATABASE_URL|DIRECT_URL/i.test(key)) env[key] = '';
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) if (existsSync(file)) {
  for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = '';
}
Object.assign(env, { NODE_ENV: 'production', DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
  NEXTAUTH_SECRET: 'synthetic_support_browser', NEXTAUTH_URL: `http://localhost:${port}`, ADMIN_SECRET: 'synthetic_admin' });
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], { env, stdio: 'ignore', windowsHide: true });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://localhost:${port}/api/admin/support`)).status === 401) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 500));
  }
  assert.ok(ready, 'isolated server ready');
  // Probe the compiled handlers, not browser mocks: external HTTPS Origin over internal HTTP.
  for (const path of ['/api/admin/support/migration', '/api/admin/support']) {
    const response = await fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: {
      authorization: 'Bearer synthetic_admin', origin: 'https://newvers.ai', 'content-type': 'application/json',
    }, body: JSON.stringify(path.endsWith('/migration') ? { action: 'apply', migration: 'unsupported' } : {}) });
    assert.equal(response.status, 400, 'compiled handler accepts public origin and rejects invalid payload before database access');
    const denied = await fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: {
      authorization: 'Bearer synthetic_admin', origin: 'https://evil.example', 'content-type': 'application/json',
    }, body: '{}' });
    assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'SUPPORT_ORIGIN_DENIED');
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const { width, mode } of [{ width: 390, mode: 'schema_only' }, { width: 1280, mode: 'schema_only' }, { width: 390, mode: 'prisma' }, { width: 1280, mode: 'prisma' }]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const ticket = { id: 'tkt_synthetic_browser', email: 'customer@example.test', topic: 'technical', status: 'open', message: 'Browser question', createdAt: new Date().toISOString(), replies: [] };
    let posts = 0;
    let migrationPosts = 0;
    let schemaReady = false;
    let failNextMigration = true;
    await page.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.hostname !== 'localhost') return route.abort();
      if (url.pathname === '/api/admin/support/migration') {
        assert.equal(request.headers().authorization, 'Bearer synthetic_admin');
        if (request.method() === 'POST') {
          assert.deepEqual(request.postDataJSON(), { action: 'apply', migration: '20261006120000_support_replies' });
          if (failNextMigration) { failNextMigration = false; return route.fulfill({ status: 403, contentType: 'text/html', body: '<h1>Forbidden</h1>' }); }
          migrationPosts++;
          schemaReady = true;
        }
        return route.fulfill({ json: { migration: '20261006120000_support_replies', ready: schemaReady, canApply: !schemaReady, mode,
          message: schemaReady ? 'База готова к ответам пользователям.' : mode === 'schema_only'
            ? 'Таблицы ответов нет. Можно создать её кнопкой ниже. История остальных миграций не изменится.'
            : 'Миграция не применена. Можно создать таблицу ответов кнопкой ниже.' } });
      }
      if (url.pathname === '/api/admin/support') {
        assert.equal(request.headers().authorization, 'Bearer synthetic_admin');
        if (request.method() === 'POST') { posts++; const body = request.postDataJSON(); assert.equal(body.ticketId, ticket.id); assert.equal(body.message, 'Browser answer'); ticket.replies.push({ id: 'reply_synthetic', message: body.message, status: 'pending', createdAt: new Date().toISOString() }); return route.fulfill({ json: { reply: ticket.replies[0] }, status: 202 }); }
        return route.fulfill({ json: url.searchParams.has('ticketId') ? { ticket, replyAvailability: { ready: schemaReady,
          ...(schemaReady ? {} : { code: 'SUPPORT_SCHEMA_NOT_READY', message: 'Отправка ответов пока недоступна: примените миграцию 20261006120000_support_replies в базе сервера.' }) } } : { tickets: [ticket], cursor: null } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: url.pathname === '/api/auth/session' ? {} : { models: [], notifications: [], balance: 0 } });
      return route.continue();
    });
    await page.goto(`http://localhost:${port}/ru/admin/support`);
    await page.getByLabel('Ключ администратора (ADMIN_SECRET)').fill('synthetic_admin');
    await page.getByRole('button', { name: 'Открыть обращения' }).click();
    await page.getByRole('button', { name: /tkt_synthetic_browser/ }).click();
    await page.getByText('Browser question', { exact: true }).waitFor();
    await page.getByRole('alert').filter({ hasText: '20261006120000_support_replies' }).waitFor();
    assert.ok(await page.getByRole('button', { name: 'Отправить ответ', exact: true }).isDisabled());
    assert.ok(await page.getByLabel('Ответ пользователю').isDisabled());
    await page.getByRole('button', { name: 'Проверить миграцию', exact: true }).click();
    await page.getByText(mode === 'schema_only' ? 'Таблицы ответов нет. Можно создать её кнопкой ниже. История остальных миграций не изменится.' : 'Миграция не применена. Можно создать таблицу ответов кнопкой ниже.', { exact: true }).waitFor();
    assert.equal(migrationPosts, 0, 'inspection never applies migration');
    const installButton = page.getByRole('button', { name: mode === 'schema_only' ? 'Создать таблицу ответов' : 'Применить миграцию', exact: true });
    assert.ok(await installButton.isDisabled());
    await page.getByLabel(mode === 'schema_only' ? 'Подтверждаю создание таблицы ответов' : 'Подтверждаю применение миграции ответов поддержки').check();
    await installButton.click();
    await page.getByRole('status').filter({ hasText: 'HTTP 403' }).waitFor();
    assert.equal(schemaReady, false); assert.equal(migrationPosts, 0, '403 cannot report successful installation');
    await installButton.click();
    await page.getByText('База готова к ответам пользователям.', { exact: true }).waitFor();
    await page.getByRole('alert').filter({ hasText: '20261006120000_support_replies' }).waitFor({ state: 'hidden' });
    assert.equal(migrationPosts, 1);
    await page.getByLabel('Ответ пользователю').fill('Browser answer');
    await page.getByRole('button', { name: 'Отправить ответ', exact: true }).click();
    await page.getByText('Ответ сохранён. Его отправит очередь поддержки.').waitFor();
    assert.equal(posts, 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow');
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('synthetic_admin')), false);
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    assert.equal(await page.getByLabel('Ключ администратора (ADMIN_SECRET)').inputValue(), '');
    await page.close();
  }
  console.log('PASS support browser: compiled proxy-origin guard, rejected foreign origin, visible HTML 403 error/retry, both installation modes on mobile/desktop, ticket/reply recovery, storage isolation');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(done => child.once('exit', done)); child.kill(); await exited; }
}
