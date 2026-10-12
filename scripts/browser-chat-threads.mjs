// Story UI in a real local Next dev server and Chromium, stories flag on.
// Isolated database (embedded PostgreSQL via the memory harness), synthetic env, every request
// outside localhost is aborted. No message is sent, so no AI provider is ever called.
// Run: npm run verify:chat-threads:browser   (GUEST_TEST_RUNTIME as for the other isolated checks)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import bcrypt from 'bcryptjs';
import { startHarness } from './lib/memory-test-harness.mjs';

let passed = 0;
const check = (name, condition, details) => {
  if (!condition) { console.error(`FAIL ${name}${details === undefined ? '' : ` ${JSON.stringify(details)}`}`); throw new Error(`Check failed: ${name}`); }
  passed += 1; console.log(`PASS ${name}`);
};
const shots = join(tmpdir(), 'nv-chat-threads-browser');
mkdirSync(shots, { recursive: true });

const h = await startHarness({ label: 'threads-browser' });
const { db, helpers } = h;
const port = await new Promise((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
});
const base = `http://localhost:${port}`;
let server, browser, page, oldThreadId = null, log = '';
try {
  // Fixture: one user, a character with three stories (one archived) and a second character.
  await helpers.model(16_000);
  const user = await helpers.user('story');
  await db.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash('ThreadsTest123!', 10), emailVerified: new Date(), name: 'Тестер' } });
  const character = await db.character.create({ data: { name: 'Вампир Лео', name_en: 'Leo the Vampire', slug: 'leo-threads-test', userId: user.id, isPublic: true,
    greeting: 'Ночь опускается на город.', greeting_en: 'Night falls on the city.', systemPrompt: 'Ты — вампир Лео.' } });
  const second = await helpers.character(user.id, 'Капитан');
  const story = async (number, title, status, minutesAgo, lines) => {
    const thread = await db.chatThread.create({ data: { userId: user.id, characterId: character.id, number, title, status,
      lastMessageAt: new Date(Date.now() - minutesAgo * 60_000) } });
    await helpers.messages(user.id, character.id, lines.map((content, index) => ({ role: index % 2 ? 'assistant' : 'user', content })),
      { threadId: thread.id, mirror: false, start: Date.now() - (minutesAgo + 10) * 60_000 });
    return thread;
  };
  const clans = await story(1, null, 'active', 60, ['Мы в Москве, у Кремля.', 'Война кланов начинается.']);
  const mars = await story(2, 'Марс', 'active', 5, ['Мы на Марсе.', 'Красная пыль кружит над кратером.']);
  const old = await story(3, 'Старая история', 'archived', 600, ['Давно это было.', 'Да, очень давно.']);
  oldThreadId = old.id;
  await helpers.messages(user.id, second.id, [{ role: 'user', content: 'Привет, капитан.' }], { threadId: (await helpers.thread(user.id, second.id)).id, mirror: false });

  // Local Next with synthetic env only; project env files are neutralized like in the other browser checks.
  const env = { ...process.env };
  for (const file of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    if (existsSync(file)) for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = '';
  }
  Object.assign(env, { DATABASE_URL: h.databaseUrl, NEXTAUTH_SECRET: 'synthetic_threads_browser_secret', NEXTAUTH_URL: base,
    NEXT_PUBLIC_APP_URL: base, NEXT_PUBLIC_YANDEX_METRIKA_ID: '999001', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
    CHAT_THREADS_ENABLED: '1', KODIKROUTER_API_KEY: 'synthetic_threads_browser_no_calls' });
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', (data) => { log = (log + data).slice(-12000); });
  server.stderr.on('data', (data) => { log = (log + data).slice(-12000); });
  for (let i = 0; i < 240 && !log.includes('Ready in'); i += 1) {
    if (server.exitCode !== null) throw new Error(`Next exited: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(log.includes('Ready in'), 'Next dev server started');

  browser = await chromium.launch({ headless: true, ...(process.env['GUEST_TEST_BROWSER_CHANNEL'] ? { channel: process.env['GUEST_TEST_BROWSER_CHANNEL'] } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const url = message.location()?.url ?? '';
    // Aborted third-party requests (analytics) are expected in this sandbox; everything else counts.
    if (/Failed to load resource/.test(message.text()) && !url.startsWith(base)) return;
    // Expected local 404s: fixture characters have no avatar files; the deleted-story address below is
    // requested on purpose; the guest transfer endpoint answers 404 when there is no guest session.
    if (/Failed to load resource: the server responded with a status of 404/.test(message.text())
      && (/\/api\/characters\/[^/]+\/avatar/.test(url) || (oldThreadId && url.includes(oldThreadId)) || url.endsWith('/api/anonymous/transfer'))) return;
    errors.push(`console: ${message.text().slice(0, 200)} @ ${url.replace(base, '')}`);
  });

  await page.goto(`${base}/ru/login?callbackUrl=${encodeURIComponent(`/ru/chat/${character.id}`)}`, { timeout: 180_000 });
  await page.locator('input[type=email]').fill(user.email);
  await page.locator('input[type=password]').fill('ThreadsTest123!');
  await page.locator('#login-submit').click();
  await page.waitForURL(`**/chat/${character.id}`, { timeout: 180_000 });
  const switcher = page.locator('main button[aria-haspopup="dialog"]');
  await switcher.waitFor();
  check('chat without a story opens the latest active story (Марс)', (await switcher.innerText()).includes('Марс')
    && await page.getByText('Красная пыль кружит над кратером.').isVisible() && !(await page.getByText('Война кланов начинается.').count()));

  await switcher.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: /Истории с персонажем/ }).waitFor();
  await dialog.locator('li').first().waitFor();
  check('story list shows active stories with the open one marked', await dialog.getByText('История 1').isVisible()
    && await dialog.locator('[aria-current="true"]').getByText('Марс').isVisible());
  await dialog.getByRole('button', { name: /Архив \(1\)/ }).click();
  check('archived stories are listed separately', await dialog.getByText('Старая история').isVisible());
  await page.screenshot({ path: join(shots, 'list-desktop.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  check('Escape closes the story list', true);

  await switcher.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Открыть историю «История 1»' }).click();
  await page.waitForURL(`**/chat/${character.id}?thread=${clans.id}`);
  await page.getByText('Война кланов начинается.').waitFor();
  check('switching opens story 1 by its address and shows only its messages', !(await page.getByText('Красная пыль кружит над кратером.').count())
    && (await switcher.innerText()).includes('История 1'));

  await switcher.click();
  const list = page.getByRole('dialog');
  const item = list.locator('li', { hasText: 'История 1' });
  await item.getByRole('button', { name: 'Переименовать' }).click();
  await list.getByLabel('Название истории').fill('Война кланов');
  await list.getByRole('button', { name: 'Сохранить' }).click();
  await list.getByText('Война кланов').first().waitFor();
  await page.keyboard.press('Escape');
  check('rename updates the list and the chat header', (await switcher.innerText()).includes('Война кланов')
    && (await db.chatThread.findUnique({ where: { id: clans.id } })).title === 'Война кланов');

  await switcher.click();
  await page.getByRole('dialog').locator('li', { hasText: 'Марс' }).getByRole('button', { name: 'В архив' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Архив \(2\)/ }).waitFor();
  check('archive moves a story to the archive section', (await db.chatThread.findUnique({ where: { id: mars.id } })).status === 'archived');
  await page.getByRole('dialog').getByRole('button', { name: /Архив \(2\)/ }).click();
  await page.getByRole('dialog').locator('li', { hasText: 'Марс' }).getByRole('button', { name: 'Вернуть из архива' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Архив \(1\)/ }).waitFor();
  check('restore brings it back', (await db.chatThread.findUnique({ where: { id: mars.id } })).status === 'active');

  const archiveToggle = page.getByRole('dialog').getByRole('button', { name: /Архив \(1\)/ });
  if (await archiveToggle.getAttribute('aria-expanded') !== 'true') await archiveToggle.click();
  const oldItem = page.getByRole('dialog').locator('li', { hasText: 'Старая история' });
  await oldItem.getByRole('button', { name: 'Удалить' }).click();
  await oldItem.getByRole('alertdialog').waitFor();
  await page.keyboard.press('Escape');
  check('Escape first cancels the inline delete confirmation, the list stays open', !(await oldItem.getByRole('alertdialog').count())
    && await page.getByRole('dialog').isVisible());
  await oldItem.getByRole('button', { name: 'Удалить' }).click();
  await oldItem.getByRole('button', { name: 'Удалить навсегда' }).click();
  await page.getByRole('dialog').getByText('Старая история', { exact: true }).waitFor({ state: 'detached' });
  check('delete with confirmation removes the story and its messages', !(await db.chatThread.findUnique({ where: { id: old.id } }))
    && (await db.message.count({ where: { threadId: old.id } })) === 0);

  await page.getByRole('dialog').getByRole('button', { name: 'Новая история' }).click();
  await page.waitForURL((url) => Boolean(url.searchParams.get('thread')) && url.searchParams.get('thread') !== clans.id);
  const createdId = new URL(page.url()).searchParams.get('thread');
  await page.getByText('Ночь опускается на город.').waitFor();
  await switcher.getByText('История 3').waitFor();
  const newStory = { createdId, header: await switcher.innerText(), oldVisible: await page.getByText('Война кланов начинается.').count() };
  check('new story opens empty with the card greeting', Boolean(createdId) && createdId !== clans.id && createdId !== mars.id
    && newStory.header.includes('История 3') && newStory.oldVisible === 0, newStory);
  await page.screenshot({ path: join(shots, 'new-story-desktop.png') });

  // Mobile width: no horizontal scroll, list usable.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await switcher.waitFor();
  await switcher.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Новая история' }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: join(shots, 'list-mobile.png') });
  check('mobile width: story list fits without horizontal scroll', overflow <= 0, overflow);
  await page.keyboard.press('Escape');

  // English locale.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/en/chat/${character.id}?thread=${mars.id}`);
  await switcher.waitFor();
  await switcher.click();
  await page.getByRole('dialog').getByRole('heading', { name: /Stories with/ }).waitFor();
  await page.getByRole('dialog').locator('li').first().waitFor();
  check('English texts in the story list', await page.getByRole('dialog').getByRole('button', { name: 'New story' }).isVisible()
    && await page.getByRole('dialog').getByText('Story 3').isVisible());
  await page.screenshot({ path: join(shots, 'list-en.png') });
  await page.keyboard.press('Escape');

  // Chats page and character page entry points.
  await page.goto(`${base}/ru/chats`);
  await page.getByText('Война кланов', { exact: true }).waitFor();
  check('/chats lists stories with their titles', await page.getByText('Марс', { exact: true }).first().isVisible()
    && await page.locator(`a[href*="thread=${clans.id}"]`).count() === 1);
  await page.goto(`${base}/ru/character/${character.slug}`);
  const cont = page.getByRole('link', { name: /Продолжить:/ });
  await cont.waitFor();
  check('character page offers "continue" for the latest story and "new story"', (await cont.innerText()).includes('История 3')
    && await page.getByRole('link', { name: 'Новая история' }).isVisible());
  await page.getByRole('link', { name: 'Новая история' }).click();
  await page.waitForURL(/thread=/);
  const fromCard = new URL(page.url()).searchParams.get('thread');
  check('"new story" on the character page creates and opens a new story once', !!fromCard && ![clans.id, mars.id, createdId].includes(fromCard)
    && (await db.chatThread.count({ where: { userId: user.id, characterId: character.id } })) === 4 && !page.url().includes('new=1'));
  await page.goto(`${base}/ru/chat/${character.id}?thread=${old.id}`);
  await page.getByText('История не найдена. Открыта последняя активная история.').waitFor();
  await page.waitForURL((url) => !url.searchParams.get('thread'));
  await switcher.getByText('История 4').waitFor();
  check('a deleted story address falls back to the latest active story', !new URL(page.url()).searchParams.get('thread'));

  check('no page errors or console errors', errors.length === 0, errors);
  console.log(`Screenshots: ${shots}`);
  console.log(`Chat threads browser verification: ${passed} passed`);
} catch (error) {
  await page?.screenshot({ path: join(shots, 'failure.png') }).catch(() => {});
  console.error(log.slice(-3000));
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true });
    else server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await h.stop();
}
