import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import bcrypt from 'bcryptjs';

export async function verifyGuestBrowser({ db, databaseUrl, store, character, user, check }) {
  const port = await new Promise((resolve, reject) => {
    const server = createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const base = `http://localhost:${port}`;
  const env = { ...process.env };
  // Neutralize every project's env-file key before Next loads it, without logging values.
  for (const file of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    if (existsSync(file)) for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = '';
  }
  Object.assign(env, { DATABASE_URL: databaseUrl, NEXTAUTH_SECRET: 'synthetic_guest_browser_secret',
    NEXTAUTH_URL: base, NEXT_PUBLIC_APP_URL: base, NEXT_PUBLIC_YANDEX_METRIKA_ID: '999001',
    GUEST_AI_STUB_REPLY: 'Guest browser reply', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' });
  if (process.env.P1_CLOSURE === '1') Object.assign(env, {
    CRON_SECRET: 'synthetic_cron_only', SUPPORT_INBOX_EMAIL: 'inbox@example.test',
    ROBOKASSA_PASSWORD2: 'synthetic_result_password', TRUST_PROXY: '1',
  });
  env.KODIKROUTER_API_KEY = 'synthetic_guest_stub_only';
  await db.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash('GuestTest123!', 10), emailVerified: new Date(), verseCoins: 500 } });
  await db.model.create({ data: { name: 'google/gemma-4-31b-it', displayName: 'Guest test', priceVC: 1, isActive: true } });
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', String(port)],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = ''; server.stdout.on('data', data => { log = (log + data).slice(-8000); });
  server.stderr.on('data', data => { log = (log + data).slice(-8000); });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error(`Private Next exited: ${log}`);
      if (log.includes('Ready in')) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, 'Private Next server started');
    browser = await chromium.launch({ headless: true, channel: process.env.GUEST_TEST_BROWSER_CHANNEL });
    const context = await browser.newContext();
    await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(45000);
    const pageErrors = [];
    page.on('pageerror', error => { pageErrors.push(error.message); console.error('Private browser page error:', error.message); });
    page.on('requestfailed', request => console.error('Private browser request failed:', request.url(), request.failure()?.errorText));
    const chatUrl = `${base}/ru/chat/${character.id}`;
    await page.goto(chatUrl, { timeout: 120000 });
    const composer = page.locator('textarea').first();
    await composer.fill('Browser guest hello'); await composer.press('Enter');
    await page.getByText('Guest browser reply', { exact: true }).waitFor();
    check(true, 'browser guest sends and receives reply');
    const guestCookie = (await context.cookies()).find(cookie => cookie.name === 'anonymousSessionId');
    assert.ok(guestCookie);
    await page.reload(); await page.getByText('Browser guest hello', { exact: true }).waitFor();
    await page.getByText('Guest browser reply', { exact: true }).waitFor();
    check(true, 'browser refresh preserves guest pair');
    const generation = { sessionId: guestCookie.value, requestId: 'browser-delayed-request', characterId: character.id,
      message: 'Delayed guest hello', quotaLimit: 5 };
    const claimed = await store.claimGuestGeneration(generation); assert.equal(claimed.kind, 'run');
    const message = await store.persistGuestUserMessage({ ...generation, attempt: claimed.attempt });
    await page.goto(`${base}/ru/login?callbackUrl=${encodeURIComponent(`/ru/chat/${character.id}`)}`, { timeout: 120000 });
    await page.locator('input[type=email]').fill(user.email);
    await page.locator('input[type=password]').fill('GuestTest123!');
    await page.locator('#login-submit').click();
    await page.waitForURL(`**/chat/${character.id}`);
    await page.getByText('Завершаем гостевой ответ и переносим диалог в аккаунт…', { exact: true }).waitFor();
    check(await page.locator('textarea').first().isDisabled(), 'browser waits visibly and prevents sending during transfer');
    await new Promise(resolve => setTimeout(resolve, 5000));
    await store.finalizeGuestGeneration({ ...generation, attempt: claimed.attempt,
      userMessageId: message.id, assistantContent: 'Delayed guest reply', remainingMessages: 3 });
    await page.getByText('Delayed guest reply', { exact: true }).waitFor();
    check(true, 'browser late generation transfers automatically without reload');
    check((await context.cookies()).every(cookie => cookie.name !== 'anonymousSessionId'), 'browser transfer clears guest cookie');
    await page.reload(); await page.getByText('Delayed guest reply', { exact: true }).waitFor();
    check(await db.message.count({ where: { userId: user.id, content: 'Delayed guest reply' } }) === 1, 'browser account reload does not duplicate transfer');
    if (process.env.P1_CLOSURE === '1') {
      const { verifyP1Browser } = await import('./browser-closure-p1.mjs');
      await verifyP1Browser({ db, context, page, base, user, check });
    }
    const csrf = await (await context.request.get(`${base}/api/auth/csrf`)).json();
    await context.request.post(`${base}/api/auth/signout`, { form: { csrfToken: csrf.csrfToken, json: 'true' } });
    await page.goto(chatUrl); await page.locator('textarea').first().waitFor();
    check(await page.getByText('Delayed guest reply', { exact: true }).count() === 0, 'browser logout does not expose account history to guest');
    check(pageErrors.length === 0, 'browser flows produce no uncaught application error');
  } catch (error) {
    console.error('Private browser server diagnostic:', log);
    throw error;
  } finally {
    await browser?.close();
    server.kill();
    await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000).unref(); } });
  }
}
