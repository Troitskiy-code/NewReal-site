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
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const ticket = { id: 'tkt_synthetic_browser', email: 'customer@example.test', topic: 'technical', status: 'open', message: 'Browser question', createdAt: new Date().toISOString(), replies: [] };
    let posts = 0;
    await page.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.hostname !== 'localhost') return route.abort();
      if (url.pathname === '/api/admin/support') {
        assert.equal(request.headers().authorization, 'Bearer synthetic_admin');
        if (request.method() === 'POST') { posts++; const body = request.postDataJSON(); assert.equal(body.ticketId, ticket.id); assert.equal(body.message, 'Browser answer'); ticket.replies.push({ id: 'reply_synthetic', message: body.message, status: 'pending', createdAt: new Date().toISOString() }); return route.fulfill({ json: { reply: ticket.replies[0] }, status: 202 }); }
        return route.fulfill({ json: url.searchParams.has('ticketId') ? { ticket } : { tickets: [ticket], cursor: null } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: url.pathname === '/api/auth/session' ? {} : { models: [], notifications: [], balance: 0 } });
      return route.continue();
    });
    await page.goto(`http://localhost:${port}/ru/admin/support`);
    await page.getByLabel('Ключ администратора (ADMIN_SECRET)').fill('synthetic_admin');
    await page.getByRole('button', { name: 'Открыть обращения' }).click();
    await page.getByRole('button', { name: /tkt_synthetic_browser/ }).click();
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
  console.log('PASS support browser: mobile/desktop, login, ticket, reply, storage isolation, logout');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(done => child.once('exit', done)); child.kill(); await exited; }
}
