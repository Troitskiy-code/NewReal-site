// Real local editor UI, synthetic session/API. External requests are blocked before navigation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env };
for (const key of Object.keys(env)) if (/(?:KEY|SECRET|TOKEN|DATABASE|DIRECT_URL|LOGTAIL)/i.test(key)) env[key] = '';
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (existsSync(name)) for (const line of readFileSync(name, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) env[match[1]] = '';
  }
}
Object.assign(env, { DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic?connect_timeout=1',
  DIRECT_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic?connect_timeout=1',
  NEXTAUTH_SECRET: 'synthetic-local-editor-test-secret', NEXTAUTH_URL: base,
  NEXT_PUBLIC_APP_URL: base, NEXT_PUBLIC_SITE_URL: base, RP_PROMPT_V2_ENABLED: 'true', NODE_ENV: 'production' });
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', data => { serverLog = (serverLog + data).slice(-4000); });
server.stderr.on('data', data => { serverLog = (serverLog + data).slice(-4000); });
let browser;
let passed = 0;
const check = (condition, label) => { assert.ok(condition, label); passed++; console.log(`PASS ${label}`); };
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Local server exited: ${serverLog}`);
    try { const response = await fetch(`${base}/robots.txt`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch { /* local start */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Local server must start');
  browser = await chromium.launch({ channel: process.env['EDITOR_TEST_BROWSER_CHANNEL'] || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let saved;
  let creations = 0;
  let updates = 0;
  let paidRequests = 0;
  const pageErrors = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/auth/session') return json({ user: { id: 'synthetic-editor-owner', name: 'Editor Test', email: 'synthetic@example.invalid', emailVerified: new Date().toISOString() }, expires: '2030-01-01T00:00:00Z' });
    if (url.pathname === '/api/characters' && request.method() === 'POST') {
      saved = { ...request.postDataJSON(), id: 'synthetic-card', userId: 'synthetic-editor-owner', promptBuilderVersion: 2 };
      creations++;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(saved) });
    }
    if (url.pathname === '/api/characters/synthetic-card') {
      if (request.method() === 'PUT') { saved = { ...saved, ...request.postDataJSON() }; updates++; }
      return json(saved);
    }
    if (url.pathname === '/api/avatar-tokens') return json({ tokensUsedThisMonth: 0, monthlyLimit: 10, monthlyRemaining: 10 });
    if (url.pathname === '/api/user/balance') return json({ verseCoins: 50, canClaimBonus: false, bonusStreak: 0 });
    if (url.pathname === '/api/currency/rates') return json({ USD: 85, EUR: 95 });
    if (/^\/api\/(?:generate-avatar|chat\/|payment\/create|generation)/.test(url.pathname)) { paidRequests++; return route.abort(); }
    if (url.pathname.startsWith('/api/')) return json([]);
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const settleLayout = () => page.waitForFunction(() => {
    const desktop = window.innerWidth >= 768;
    const panel = [...document.querySelectorAll('aside')].find(item => getComputedStyle(item).display !== 'none' && getComputedStyle(item).position === 'fixed');
    const expected = desktop ? (window.innerWidth >= 1024 ? 232 : 80) : 0;
    return Math.abs(parseFloat(getComputedStyle(document.body).paddingLeft) - expected) < 1
      && (!desktop || Math.abs((panel?.getBoundingClientRect().width ?? 0) - expected) < 1);
  });
  mkdirSync('docs/roleplay-editor-local-qa', { recursive: true });
  await page.goto(`${base}/ru/create`);
  await page.getByRole('link', { name: 'Один персонаж', exact: true }).waitFor();
  check(await page.locator('#name').count() === 0 && await page.locator('main a[href*="/create/"]').count() === 3, 'entry page shows three type cards before any form');
  const art = page.locator('main a[href*="/create/"] img');
  await art.evaluateAll(images => Promise.all(images.map(image => image.decode())));
  check(await art.evaluateAll(images => images.length === 3 && images.every(image => image.naturalWidth > 0)), 'all three approved illustrations load through local image optimization');
  await settleLayout();
  check(await page.locator('main h1').evaluate(element => element.getBoundingClientRect().left >= 232), 'desktop heading clears the labelled sidebar');
  await page.screenshot({ path: 'docs/roleplay-editor-local-qa/selection-desktop.png' });
  const menuToggle = page.getByRole('button', { name: 'Открыть меню', exact: true });
  check(await menuToggle.isHidden(), 'desktop has a persistent sidebar without a drawer toggle');
  await page.setViewportSize({ width: 800, height: 900 });
  await settleLayout();
  check(await page.locator('main a[href*="/create/"]').evaluateAll(cards => cards.every(card => {
    const bounds = card.getBoundingClientRect();
    const caption = card.lastElementChild.getBoundingClientRect();
    return caption.top >= bounds.top && caption.bottom <= bounds.bottom;
  })), 'tablet icon rail keeps captions inside the cards');
  await page.setViewportSize({ width: 390, height: 844 });
  await settleLayout();
  await menuToggle.click();
  await page.locator('.nv-mobile-drawer.is-open').waitFor();
  check(await page.getByRole('button', { name: 'Закрыть меню', exact: true }).isVisible(), 'mobile drawer opens from the header');
  await page.getByRole('button', { name: 'Закрыть меню', exact: true }).click();
  await page.locator('.nv-mobile-drawer.is-open').waitFor({ state: 'hidden' });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile type selection has no horizontal overflow');
  await page.screenshot({ path: 'docs/roleplay-editor-local-qa/selection-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await settleLayout();
  await page.getByRole('link', { name: 'Один персонаж', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.locator('#name').waitFor();
  check(new URL(page.url()).pathname === '/ru/create/character' && await page.getByRole('group', { name: 'Тип карточки' }).count() === 0, 'keyboard choice opens the dedicated single editor without a second selector');
  check(await page.locator('#appearance').isVisible(), 'single character shows appearance');
  check(await page.locator('#descriptionCard').isVisible() && await page.locator('#scenario').isVisible(), 'catalog description and initial situation are in main form');
  check(await page.locator('#exampleDialogs').count() === 0, 'examples are hidden in optional settings');
  await page.locator('#name').fill('Временная идея');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: /Выбрать другой тип/ }).click();
  check(await page.locator('#name').inputValue() === 'Временная идея' && new URL(page.url()).pathname === '/ru/create/character', 'cancelled type change keeps an unsaved draft');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: /Выбрать другой тип/ }).click();
  await page.getByRole('link', { name: 'Вселенная', exact: true }).click();
  await page.locator('#npcs').waitFor();
  check(new URL(page.url()).pathname === '/ru/create/world', 'universe card navigates to its own editor');
  check(await page.locator('#appearance').count() === 0 && await page.locator('#npcs').isVisible(), 'universe has NPCs instead of a single appearance');
  check(await page.getByText('Обложка истории', { exact: true }).isVisible(), 'universe image is a cover');
  await page.getByRole('button', { name: /Выбрать другой тип/ }).click();
  await page.getByRole('link', { name: 'Несколько персонажей', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить персонажа', exact: true }).waitFor();
  check(new URL(page.url()).pathname === '/ru/create/group', 'ensemble card opens the group editor directly');
  await page.locator('#name').fill('Черновик');
  await page.getByRole('button', { name: 'Очистить черновик', exact: true }).click();
  check(await page.getByRole('button', { name: 'Добавить персонажа', exact: true }).isVisible() && await page.locator('#name').inputValue() === '', 'clearing a group draft preserves the selected type');
  await page.locator('#name').fill('Экспедиция');
  await page.locator('#descriptionCard').fill('Восемь героев в одной истории');
  for (let index = 0; index < 8; index++) {
    await page.getByRole('button', { name: 'Добавить персонажа', exact: true }).click();
    await page.getByRole('textbox', { name: `Имя персонажа ${index + 1}`, exact: true }).fill(`Герой ${index + 1}`);
    if (index !== 0) await page.locator('[id^="member-"][id$="-description"]').nth(index).fill(`Характер героя ${index + 1}`);
    if (index === 1) {
      await page.getByRole('button', { name: 'Создать', exact: true }).click();
      check(creations === 0 && await page.locator('[id^="member-"][id$="-description"]').first().isVisible(), 'invalid collapsed member opens and blocks submission');
      await page.locator('[id^="member-"][id$="-description"]').first().fill('Характер героя 1');
    }
  }
  check(await page.getByRole('button', { name: 'Добавить персонажа', exact: true }).isDisabled(), 'ninth member is unavailable in UI');
  const createdResponse = page.waitForResponse(response => response.url() === `${base}/api/characters` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await createdResponse;
  check(creations === 1 && saved.roleplayMode === 'group' && saved.rpConfig.participants.length === 8, 'create UI serializes one group card with eight members');
  const ids = saved.rpConfig.participants.map(member => member.id);
  check(new Set(ids).size === 8, 'participants receive distinct stable IDs');
  await page.goto(`${base}/ru/edit/synthetic-card`);
  await page.getByRole('button', { name: 'Добавить персонажа', exact: true }).waitFor();
  check(await page.getByRole('textbox', { name: 'Имя персонажа 8', exact: true }).inputValue() === 'Герой 8', 'edit reload restores participant fields');
  check(await page.getByRole('group', { name: 'Тип карточки' }).getByRole('button', { name: 'Несколько персонажей', exact: true }).getAttribute('aria-pressed') === 'true', 'existing editor displays the selected illustrated type');
  await page.getByRole('button', { name: 'Расширенные настройки', exact: true }).click();
  await page.getByText('Переход со старых инструкций и откат', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Подтверждаю выбор версии после сохранения карточки', exact: true }).check();
  check(await page.getByRole('button', { name: 'Вернуть прежнюю сборку', exact: true }).isDisabled(), 'group editor cannot roll back to unsupported legacy rules');
  await page.getByRole('button', { name: 'Расширенные настройки', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await settleLayout();
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile form has no horizontal overflow');
  mkdirSync('docs/roleplay-editor-local-qa', { recursive: true });
  await page.screenshot({ path: 'docs/roleplay-editor-local-qa/group-mobile.png', fullPage: false });
  await page.getByRole('heading', { name: /Персонажи истории/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/roleplay-editor-local-qa/group-members-mobile.png', fullPage: false });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Убрать персонажа', exact: true }).last().click();
  check(await page.getByRole('button', { name: 'Добавить персонажа', exact: true }).isEnabled(), 'removing a member frees one slot');
  await page.getByRole('button', { name: 'Добавить персонажа', exact: true }).click();
  await page.getByRole('textbox', { name: 'Имя персонажа 8', exact: true }).fill('Новый герой');
  await page.locator('[id^="member-"][id$="-description"]').last().fill('Присоединяется к экспедиции');
  const updatedResponse = page.waitForResponse(response => response.url() === `${base}/api/characters/synthetic-card` && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await updatedResponse;
  check(updates === 1 && saved.rpConfig.participants.length === 8 && saved.rpConfig.participants[7].id !== ids[7] && saved.rpConfig.participants.slice(0, 7).every((member, index) => member.id === ids[index]), 'save preserves remaining identities and gives replacement a new ID');
  const invalid = await page.goto(`${base}/ru/create/unknown`);
  check(invalid.status() === 404, 'unknown type route returns 404');
  await page.goto(`${base}/en/create`);
  await page.getByRole('link', { name: 'Вселенная', exact: true }).waitFor();
  check(await page.getByRole('link', { name: 'Вселенная', exact: true }).getAttribute('href') === '/en/create/world', 'type navigation preserves the active locale');
  check(paidRequests === 0, 'editor flow makes no paid requests');
  check(pageErrors.length === 0, `no uncaught browser errors: ${pageErrors.join('; ')}`);
  console.log(`\n${passed} browser checks passed; local fixtures only, no production/paid API.`);
} finally {
  if (browser) await browser.close();
  server.kill();
}
