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
        if (request.method() === 'POST') {
          posts++; const body = request.postDataJSON();
          if (body.action === 'deliver') {
            assert.equal(body.replyId, 'reply_synthetic');
            Object.assign(ticket.replies[0], { status: 'accepted', attempts: 2, providerId: 'synthetic_mail_id', nextAttemptAt: null });
          } else {
            assert.equal(body.ticketId, ticket.id); assert.equal(body.message, 'Browser answer');
            ticket.replies.push({ id: 'reply_synthetic', message: body.message, status: mode === 'prisma' ? 'failed' : 'accepted',
              attempts: 1, providerId: mode === 'prisma' ? null : 'synthetic_mail_id',
              nextAttemptAt: mode === 'prisma' ? new Date(0).toISOString() : null, createdAt: new Date().toISOString() });
          }
          return route.fulfill({ json: { reply: ticket.replies[0], delivery: { message: ticket.replies[0].status === 'accepted'
            ? 'Ответ принят Resend. Доставку получателю можно проверить в кабинете Resend.'
            : 'Ответ сохранён, но Resend отклонил доступ. Проверьте API-ключ и его права на отправку с домена newvers.ai.' } }, status: 202 });
        }
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
    await page.getByRole('status').filter({ hasText: mode === 'prisma' ? 'Resend отклонил доступ' : 'Ответ принят Resend' }).waitFor();
    assert.equal(posts, 1);
    assert.equal(await page.getByLabel('Ответ пользователю').inputValue(), '', 'saved answer cleared even if delivery is deferred');
    if (mode === 'prisma') {
      await page.getByText('Следующая попытка не раньше', { exact: false }).waitFor();
      await page.getByLabel('Ответ пользователю').fill('Unsent draft');
      await page.getByRole('button', { name: 'Обновить статус ответа', exact: true }).click();
      assert.equal(await page.getByLabel('Ответ пользователю').inputValue(), 'Unsent draft', 'status refresh preserves unsent draft');
      await page.getByRole('button', { name: 'Отправить сохранённый ответ', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Ответ принят Resend' }).waitFor();
      assert.equal(posts, 2); assert.equal(ticket.replies.length, 1, 'retry does not save another message');
      assert.equal(await page.getByLabel('Ответ пользователю').inputValue(), 'Unsent draft', 'retry preserves unrelated draft');
    }
    await page.getByText('ID письма Resend: synthetic_mail_id').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Отправить сохранённый ответ', exact: true }).count(), 0, 'accepted replies cannot be sent again');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow');
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('synthetic_admin')), false);
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    assert.equal(await page.getByLabel('Ключ администратора (ADMIN_SECRET)').inputValue(), '');
    await page.close();
  }
  for (const { width, locale } of [{ width: 390, locale: 'ru' }, { width: 1280, locale: 'en' }]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const words = JSON.parse(readFileSync(`public/locales/${locale}/common.json`, 'utf8')).support;
    const reference = 'cmu_synthetic_reference';
    let requests = 0; let savedPayload;
    await page.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.hostname !== 'localhost') return route.abort();
      if (url.pathname === '/api/support' && request.method() === 'POST') {
        requests++;
        const payload = request.postDataJSON();
        assert.equal(payload.referenceTicketId, reference);
        assert.equal(payload.email, 'customer@example.test');
        assert.equal(payload.message, 'Follow-up from browser');
        if (requests === 1) { savedPayload = payload; return route.abort('failed'); }
        assert.deepEqual(payload, savedPayload, 'lost response/reload reuses the entire payload and key');
        return route.fulfill({ status: 200, json: { ok: true, replayed: true, ticketId: 'tkt_synthetic_follow_up' } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: url.pathname === '/api/auth/session' ? {} : { models: [], notifications: [], balance: 0 } });
      return route.continue();
    });
    await page.goto(`http://localhost:${port}/${locale}/support`);
    await page.getByLabel(words.referenceTicket, { exact: true }).waitFor();
    assert.equal(await page.locator('#support-reference').getAttribute('required'), null, 'reference is optional');
    await page.locator('#support-email').fill('Customer@example.test');
    await page.locator('#support-reference').fill(reference);
    await page.locator('#support-message').fill('Follow-up from browser');
    await page.getByRole('button', { name: words.submit, exact: true }).click();
    await page.getByText(words.error, { exact: true }).waitFor();
    await page.reload();
    await page.waitForFunction(expected => document.querySelector('#support-reference')?.value === expected, reference);
    assert.equal(await page.locator('#support-message').inputValue(), 'Follow-up from browser');
    await page.getByRole('button', { name: words.submit, exact: true }).click();
    await page.getByText('tkt_synthetic_follow_up', { exact: false }).waitFor();
    assert.equal(requests, 2); assert.equal(await page.locator('#support-message').inputValue(), '');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'public form fits viewport');
    await page.close();
  }
  console.log('PASS support browser: public reference RU/EN/mobile/desktop, draft/replay after lost response, optional field, admin delivery/retry/status, proxy guard and storage isolation');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(done => child.once('exit', done)); child.kill(); await exited; }
}
