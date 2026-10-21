// Telegram Mini App in a real local Next dev server: proxy, cookies, NextAuth session, pages
// without purchases, Metrika privacy, Telegram WebApp emulation (stub SDK, signed initData),
// Telegram Web frame (partitioned cookie), mobile width, dark/light theme, RU/EN.
// Isolated database (embedded PostgreSQL via the memory harness), synthetic env and bot token,
// every request outside localhost is aborted or answered by a local stub. No AI call is made.
// Run: npm run verify:telegram:server   (GUEST_TEST_RUNTIME as for the other isolated checks)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import bcrypt from 'bcryptjs';
import { startHarness } from './lib/memory-test-harness.mjs';

let passed = 0;
const check = (name, condition, details) => {
  if (!condition) { console.error(`FAIL ${name}${details === undefined ? '' : ` ${JSON.stringify(details).slice(0, 1500)}`}`); throw new Error(`Check failed: ${name}`); }
  passed += 1; console.log(`PASS ${name}`);
};
const shots = join(tmpdir(), 'nv-telegram-miniapp');
mkdirSync(shots, { recursive: true });

// The harness replaces fetch with a guard against provider calls; HTTP checks use the real one.
const nativeFetch = globalThis.fetch;
const h = await startHarness({ label: 'telegram-server' });
const { db, load, root } = h;
const { signInitData } = load(join(root, 'src/lib/telegram/initData.ts'));
const port = await new Promise((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
});
const base = `http://localhost:${port}`;
const BOT_TOKEN = `${700000000 + Math.floor(Math.random() * 1e8)}:${randomBytes(27).toString('base64url')}`;
const WEBHOOK_SECRET = randomBytes(24).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const launch = (telegramId, { language = 'ru', startParam, firstName = 'Тест' } = {}) => signInitData({
  query_id: `AAH${randomBytes(8).toString('hex')}`,
  user: `{"id":${telegramId},"first_name":${JSON.stringify(firstName)},"language_code":"${language}"}`,
  auth_date: String(now()),
  ...(startParam ? { start_param: startParam } : {}),
}, BOT_TOKEN);
const fragment = (initData, extra = '') => `tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0&tgWebAppPlatform=android${extra}`;

// Purchase markers looked for in HTML and in the rendered page.
const SHOP_PATH = /(?:^|\/)(?:coins|pricing|subscription|tokens|realcoins|balance|offer|refund)(?=$|[/?#])|robokassa|\/api\/(?:payment|subscription|coins|checkout|billing)/i;
const SHOP_TEXT = /₽|\bруб\.?(?=\s|$)|\bRUB\b|Robokassa|\bКупить\b|\bBuy\b|Пополн|Top up|Оформить подписку|Тарифы|Subscribe|подписк[аиу] (?:Диалог|История|Вселенная)/i;
function purchaseFindings({ text, links, actions }) {
  const hits = [];
  for (const action of actions) if (/checkout/.test(action)) hits.push(`action:${action}`);
  for (const link of links) if (SHOP_PATH.test(link)) hits.push(`link:${link}`);
  const match = text.match(new RegExp(`.{0,40}(?:${SHOP_TEXT.source}).{0,40}`, 'i'));
  if (match) hits.push(`text:${match[0]}`);
  return hits;
}
function htmlParts(html) {
  return {
    text: html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '),
    links: [...html.matchAll(/\s(?:href|action)="([^"]*)"/g)].map((match) => match[1]),
    actions: [...html.matchAll(/data-action="([^"]*)"/g)].map((match) => match[1]),
  };
}

let server, browser, frameBrowser, log = '';
try {
  // ------------------------------------------------------------------------------------------
  // Fixture: an author with an approved and a hidden character, a site user with a password.
  // ------------------------------------------------------------------------------------------
  await h.helpers.model(16_000);
  const author = await db.user.create({ data: { email: 'author-tg@example.test', name: 'Автор' } });
  const listed = await db.character.create({ data: { name: 'Вампир Лео', name_en: 'Leo the Vampire', slug: 'leo-vampire', userId: author.id, isPublic: true,
    greeting: 'Ночь опускается на город.', greeting_en: 'Night falls.', systemPrompt: 'Ты — вампир Лео.', descriptionCard: 'Вампир из старого города.' } });
  const hidden = await db.character.create({ data: { name: 'Скрытая Лилит', slug: 'hidden-lilith', userId: author.id, isPublic: true, systemPrompt: 'Ты — Лилит.' } });
  const privateOther = await db.character.create({ data: { name: 'Приватная Лилит', slug: 'private-lilith', userId: author.id, isPublic: false, systemPrompt: 'Private.' } });
  await db.telegramCatalogEntry.create({ data: { characterId: listed.id } });
  const siteUser = await db.user.create({ data: { email: 'site-tg@example.test', name: 'Сайт', password: await bcrypt.hash('SiteTest123!', 10), emailVerified: new Date(), verseCoins: 500 } });

  const env = { ...process.env };
  for (const file of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    if (existsSync(file)) for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = '';
  }
  Object.assign(env, { DATABASE_URL: h.databaseUrl, NEXTAUTH_SECRET: 'synthetic_telegram_server_secret', NEXTAUTH_URL: base,
    NEXT_PUBLIC_APP_URL: base, NEXT_PUBLIC_YANDEX_METRIKA_ID: '999001', NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
    CHAT_THREADS_ENABLED: '1', KODIKROUTER_API_KEY: 'synthetic_no_calls', TELEGRAM_MINIAPP_ENABLED: '1', TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET, TELEGRAM_BOT_USERNAME: 'nv_synthetic_bot' });
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', (data) => { log = (log + data).slice(-200000); });
  server.stderr.on('data', (data) => { log = (log + data).slice(-200000); });
  for (let i = 0; i < 240 && !log.includes('Ready in'); i += 1) {
    if (server.exitCode !== null) throw new Error(`Next exited: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check('Next dev server started', log.includes('Ready in'));

  // ------------------------------------------------------------------------------------------
  // HTTP: webhook, sign-in, NextAuth session through the proxy, CSRF guard, purchase APIs
  // ------------------------------------------------------------------------------------------
  const request = (path, { method = 'GET', cookie = '', headers = {}, body } = {}) => nativeFetch(`${base}${path}`, {
    method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(body ? { body } : {}),
  });
  const jar = (response, previous = '') => {
    const map = new Map(previous.split('; ').filter(Boolean).map((part) => [part.split('=')[0], part]));
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const name = pair.split('=')[0];
      if (/Max-Age=0/i.test(line) || pair.endsWith('=')) map.delete(name); else map.set(name, pair);
    }
    return [...map.values()].join('; ');
  };
  const sameOrigin = { origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

  const unauthorized = await request('/api/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const started = await request('/api/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    body: JSON.stringify({ update_id: 1, message: { text: '/start', chat: { id: 501, type: 'private' }, from: { id: 501, is_bot: false, language_code: 'ru' } } }) });
  const startBody = await started.json();
  check('4.3 HTTP: webhook without the secret header is 401, with it /start answers with the Mini App button',
    unauthorized.status === 401 && started.status === 200 && startBody.reply_markup.inline_keyboard[0][0].web_app.url === `${base}/tg`);

  const TG_HTTP = '7770001';
  const signIn = await request('/api/telegram/auth', { method: 'POST', headers: sameOrigin, body: JSON.stringify({ initData: launch(TG_HTTP), consent: true }) });
  let tgCookies = jar(signIn);
  const signInBody = await signIn.json();
  const httpUser = await db.user.findFirst({ where: { telegramAccount: { telegramId: TG_HTTP } } });
  check('2.11 HTTP: Telegram sign-in sets the Telegram session and context cookies', signIn.status === 200 && signInBody.status === 'ok'
    && /nv-tg\.session-token=/.test(tgCookies) && /nv-tg\.ctx=1/.test(tgCookies), { status: signIn.status, body: signInBody });
  const sessionRes = await request('/api/auth/session', { cookie: tgCookies });
  const sessionBody = await sessionRes.json();
  check('2.12 NextAuth sees an ordinary session for the Telegram cookie (proxy mapping)', sessionBody?.user?.id === httpUser.id, sessionBody);
  check('7.2 a Telegram registration is reported once as a registration (register_success source)',
    sessionBody.user.oauthRegistrationUserId === httpUser.id && !sessionBody.user.email);
  const second = await request('/api/telegram/auth', { method: 'POST', headers: sameOrigin, body: JSON.stringify({ initData: launch(TG_HTTP) }) });
  const secondCookies = jar(second);
  const secondSession = await (await request('/api/auth/session', { cookie: secondCookies })).json();
  check('7.3 a later launch is a sign-in, not a second registration', secondSession.user.id === httpUser.id && !secondSession.user.oauthRegistrationUserId);
  const noCtx = tgCookies.split('; ').filter((part) => !part.startsWith('nv-tg.ctx=')).join('; ');
  const withoutContext = await (await request('/api/auth/session', { cookie: noCtx })).json();
  check('8.2 the Telegram session cookie alone (without the context cookie) is not a session', !withoutContext?.user);

  const crossSite = await request('/api/daily-bonus', { method: 'POST', cookie: tgCookies, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
  const sameSiteBonus = await request('/api/daily-bonus', { method: 'POST', cookie: tgCookies, headers: { origin: base, 'sec-fetch-site': 'same-origin' } });
  check('8.3 CSRF guard: a cross-site write with the SameSite=None cookie gets no session; same-origin works',
    crossSite.status === 401 && sameSiteBonus.status === 200, { cross: crossSite.status, same: sameSiteBonus.status });
  const blocked = await request('/api/payment/create', { method: 'POST', cookie: tgCookies, headers: sameOrigin, body: JSON.stringify({ packageId: 'vc_100' }) });
  const blockedOffer = await request('/api/coins/offer', { cookie: tgCookies });
  const blockedBody = await blocked.json();
  check('5.7 purchase APIs answer 403 with a neutral text in Telegram', blocked.status === 403 && blockedOffer.status === 403
    && blockedBody.code === 'TELEGRAM_UNAVAILABLE' && !/купи|оплат|сайт/i.test(blockedBody.error), blockedBody);
  const siteSignedOut = await request('/api/payment/create', { method: 'POST', headers: sameOrigin, body: '{}' });
  check('5.8 outside Telegram the payment API is untouched by the Telegram block', siteSignedOut.status !== 403 || (await siteSignedOut.json()).code !== 'TELEGRAM_UNAVAILABLE');
  const balance = await (await request('/api/user/balance', { cookie: tgCookies })).json();
  check('5.9 the VC balance API works in Telegram (balance stays visible)', Number.isInteger(balance.verseCoins) && balance.verseCoins > 0, balance);

  // ------------------------------------------------------------------------------------------
  // Pages: every page in the Telegram context is free of prices, purchase buttons and shop links
  // ------------------------------------------------------------------------------------------
  const only = process.env['VERIFY_TG_ONLY'] ?? '';
  const tgPages = only ? [] : ['/ru', '/ru/chats', '/ru/favorites', '/ru/create', '/ru/profile', '/ru/notifications', '/ru/referral', '/ru/support', '/ru/rules',
    `/ru/character/${listed.slug}`, `/ru/chat/${listed.id}`, '/ru/coins', '/ru/coins?characterId=x', '/ru/pricing', '/ru/subscription', '/ru/tokens', '/ru/realcoins', '/ru/balance',
    '/ru/offer', '/ru/refund', '/ru/terms', '/ru/privacy', '/ru/login', '/ru/register', '/en/register', '/en', '/en/coins', '/en/pricing', '/en/profile', '/tg', '/ru/tg/unavailable?section=shop'];
  const pageFindings = {};
  const headerProblems = [];
  for (const path of tgPages) {
    let response = await request(path, { cookie: tgCookies });
    for (let hop = 0; hop < 3 && [301, 302, 307, 308].includes(response.status); hop += 1) {
      response = await request(new URL(response.headers.get('location'), base).pathname, { cookie: tgCookies });
    }
    const html = await response.text();
    const hits = purchaseFindings(htmlParts(html));
    if (response.status !== 200) hits.push(`status:${response.status}`);
    if (hits.length) pageFindings[path] = hits;
    if (!/frame-ancestors 'self' https:\/\/telegram\.org https:\/\/\*\.telegram\.org/.test(response.headers.get('content-security-policy') ?? '')) headerProblems.push(path);
    if (!html.includes('data-telegram="1"')) headerProblems.push(`${path}:no-telegram-mode`);
  }
  check('5.10 Telegram context: no prices, purchase buttons, shop or payment links on any page (SSR HTML)', Object.keys(pageFindings).length === 0, pageFindings);
  check('8.4 Telegram responses allow framing only by Telegram (frame-ancestors) and render Telegram mode', headerProblems.length === 0, headerProblems);
  const shop = await (await request('/ru/coins', { cookie: tgCookies })).text();
  const doc = await (await request('/ru/terms', { cookie: tgCookies })).text();
  check('5.11 /coins in Telegram is the neutral balance page; /terms offers the document only in the browser',
    shop.includes('data-testid="telegram-neutral-page"') && shop.includes('Баланс VC') && doc.includes('Открыть в браузере') && !doc.includes('Robokassa'));
  const register = await (await request('/ru/register', { cookie: tgCookies })).text();
  check('5.24 registration in Telegram is the Telegram sign-in (no site form with the offer)', register.includes('data-testid="telegram-entry"') && !register.includes('/offer'));
  const hiddenPage = await request(`/ru/character/${hidden.slug}`, { cookie: tgCookies });
  const hiddenChat = await request(`/ru/chat/${hidden.id}`, { cookie: tgCookies });
  const hiddenBodies = (await hiddenPage.text()) + (await hiddenChat.text());
  check('8.5 direct links to public characters without a legacy entry open in Telegram', hiddenPage.status === 200 && hiddenChat.status === 200
    && hiddenBodies.includes('Лилит'), [hiddenPage.status, hiddenChat.status]);
  const privatePage = await request(`/ru/character/${privateOther.slug}`, { cookie: tgCookies });
  const privateChat = await request(`/ru/chat/${privateOther.id}`, { cookie: tgCookies });
  const privateBodies = (await privatePage.text()) + (await privateChat.text());
  check('private cards and chat metadata remain hidden in Telegram', privatePage.status === 404 && privateChat.status === 404 && !privateBodies.includes('Приватная Лилит'));
  const tgHome = await (await request('/ru', { cookie: tgCookies })).text();
  check('8.6 Telegram catalog lists all public cards, without private cards', tgHome.includes('Вампир Лео') && tgHome.includes('Скрытая Лилит') && !tgHome.includes('Приватная Лилит'));
  const entry = await request('/tg');
  check('9.5 /tg is served in place (no redirect that could drop the fragment) and is noindex', entry.status === 200
    && /noindex/.test(entry.headers.get('x-robots-tag') ?? '') && (await entry.text()).includes('noindex'));

  // The website without Telegram cookies is unchanged.
  const siteCoins = await request('/ru/coins');
  const siteCoinsHtml = await siteCoins.text();
  const siteHome = await (await request('/ru')).text();
  const siteHidden = await request(`/ru/character/${hidden.slug}`);
  const siteState = {
    coinsStatus: siteCoins.status,
    coinsNotNeutral: !siteCoinsHtml.includes('telegram-neutral-page'),
    catalogHasAll: siteHome.includes('Скрытая Лилит'),
    hiddenOpens: siteHidden.status,
    noFramePolicy: !siteCoins.headers.get('content-security-policy'),
    noTelegramMode: !/data-telegram=/.test(siteHome),
    noLaunchScript: !siteHome.includes('nv-tg-launch'),
  };
  // The shop's purchase buttons render on the client; the browser part (B5) checks them.
  check('5.12 website: shop and catalog unchanged, no Telegram mode, no frame policy, no launch script',
    siteState.coinsStatus === 200 && siteState.coinsNotNeutral && siteState.catalogHasAll && siteState.hiddenOpens === 200
    && siteState.noFramePolicy && siteState.noTelegramMode && siteState.noLaunchScript, siteState);
  const sitemap = await (await request('/sitemap.xml')).text();
  check('9.6 sitemap does not list Mini App pages', !/\/tg(?:[/<"])/.test(sitemap));

  // ------------------------------------------------------------------------------------------
  // Browser: Telegram WebApp emulation
  // ------------------------------------------------------------------------------------------
  const SDK_STUB = `(function(){
    var params={};try{params=JSON.parse(sessionStorage.getItem('__telegram__initParams')||'{}')}catch(e){}
    new URLSearchParams(location.hash.slice(1)).forEach(function(v,k){params[k]=v;});
    var calls=JSON.parse(sessionStorage.getItem('test:tg')||'[]');
    function rec(x){calls.push(x);sessionStorage.setItem('test:tg',JSON.stringify(calls));}
    var back={show:function(){rec('back:show')},hide:function(){rec('back:hide')},onClick:function(cb){window.__tgBack=cb},offClick:function(){}};
    window.Telegram={WebApp:{initData:params.tgWebAppData||'',version:params.tgWebAppVersion||'8.0',colorScheme:window.__tgScheme||'dark',
      ready:function(){rec('ready')},expand:function(){rec('expand')},isVersionAtLeast:function(v){return parseFloat(this.version)>=parseFloat(v)},
      setHeaderColor:function(c){rec('header:'+c)},setBackgroundColor:function(c){rec('bg:'+c)},setBottomBarColor:function(c){rec('bottom:'+c)},
      disableVerticalSwipes:function(){rec('noswipe')},openLink:function(u){rec('openLink:'+u)},openTelegramLink:function(u){rec('tglink:'+u)},
      safeAreaInset:{top:0,bottom:0,left:0,right:0},contentSafeAreaInset:{top:0,bottom:0,left:0,right:0},
      onEvent:function(name,cb){(window.__tgEvents||(window.__tgEvents={}))[name]=cb},offEvent:function(name){delete (window.__tgEvents||{})[name]},BackButton:back}};
  })();`;
  const METRIKA_STUB = `(function(){
    function save(entry){var log=JSON.parse(sessionStorage.getItem('test:ym')||'[]');log.push(entry);sessionStorage.setItem('test:ym',JSON.stringify(log));}
    save({type:'load',href:location.href,referrer:document.referrer});
    var queued=(window.ym&&window.ym.a)||[];
    function handle(args){var a=Array.prototype.slice.call(args);
      save({type:'call',method:a[1],args:JSON.stringify(a.slice(2).filter(function(x){return typeof x!=='function'})),href:location.href});
      if(a[1]==='init'){window['yaCounter'+a[0]]={};setTimeout(function(){window.dispatchEvent(new Event('yacounter'+a[0]+'inited'))},0);}
      var cb=a.filter(function(x){return typeof x==='function'})[0];if(cb)cb();}
    window.ym=function(){handle(arguments)};for(var i=0;i<queued.length;i++)handle(queued[i]);
  })();`;
  browser = await chromium.launch({ headless: true, ...(process.env['GUEST_TEST_BROWSER_CHANNEL'] ? { channel: process.env['GUEST_TEST_BROWSER_CHANNEL'] } : {}) });
  const requests = [];
  async function telegramContext({ scheme = 'dark', locale = 'ru-RU', mobile = true, hostPage = null, using = browser } = {}) {
    const context = await using.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 900 } }),
      colorScheme: scheme, locale,
    });
    await context.addInitScript(`window.__tgScheme=${JSON.stringify(scheme)};`);
    context.on('request', (req) => requests.push({ url: req.url(), referer: req.headers().referer ?? '' }));
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('https://telegram.org/js/telegram-web-app.js')) return route.fulfill({ contentType: 'application/javascript', body: SDK_STUB });
      if (/^https:\/\/mc\.yandex\.(com|ru)\/metrika\/tag\.js$/.test(url)) return route.fulfill({ contentType: 'application/javascript', body: METRIKA_STUB });
      if (hostPage && url.startsWith(hostPage.origin)) return route.fulfill({ contentType: 'text/html', body: hostPage.html });
      if (url.startsWith(base)) return route.continue();
      return route.abort();
    });
    const errors = [];
    const attach = (page) => {
      page.setDefaultTimeout(90_000);
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const url = message.location()?.url ?? '';
        if (/Failed to load resource/.test(message.text()) && !url.startsWith(base)) return;
        if (/status of 404/.test(message.text()) && /\/api\/characters\/[^/]+\/avatar|\/api\/anonymous\/transfer/.test(url)) return;
        errors.push(`console: ${message.text().slice(0, 200)} @ ${url.replace(base, '')}`);
      });
    };
    return { context, errors, attach };
  }
  const domParts = (page) => page.evaluate(() => ({
    text: document.body.innerText,
    links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
    actions: [...document.querySelectorAll('[data-action]')].map((element) => element.getAttribute('data-action')),
  }));
  const settle = (page, ms = 1500) => page.waitForTimeout(ms);

  // B1. New Telegram user, Android, dark theme, Russian.
  const TG_BROWSER = '7770002';
  if (!only) {
    const { context, errors, attach } = await telegramContext({ scheme: 'dark' });
    const page = await context.newPage();
    attach(page);
    await page.goto(`${base}/tg#${fragment(launch(TG_BROWSER, { startParam: 'autumn_ad' }))}`, { timeout: 180_000 });
    await page.locator('[data-testid="telegram-entry"][data-state="consent"]').waitFor({ timeout: 180_000 });
    const entryUrl = page.url();
    check('6.11 browser: after load the address has no tgWebAppData and carries the Telegram source', !entryUrl.includes('tgWebAppData') && !entryUrl.includes('#')
      && entryUrl.includes('utm_source=telegram_miniapp') && entryUrl.includes('utm_campaign=autumn_ad'), entryUrl);
    await page.screenshot({ path: join(shots, 'consent-dark.png') });
    const consentParts = await domParts(page);
    check('5.13 consent screen: no purchase elements, terms open outside the app', purchaseFindings(consentParts).length === 0, purchaseFindings(consentParts));
    for (const box of await page.locator('[data-testid="telegram-entry"] input[type=checkbox]').all()) await box.check();
    await page.getByRole('button', { name: 'Продолжить' }).click();
    await page.waitForURL(`${base}/ru`, { timeout: 180_000 });
    await page.getByText('Вампир Лео').first().waitFor();
    await settle(page, 2500);
    const user = await db.user.findFirst({ where: { telegramAccount: { telegramId: TG_BROWSER } } });
    check('2.13 browser: consent creates the account and opens the catalog in the Telegram context', Boolean(user) && await page.locator('html[data-telegram="1"]').count() === 1);
    check('8.7 browser: full public catalog is visible, private cards are hidden', (await page.getByText('Скрытая Лилит').count()) > 0 && !(await page.getByText('Приватная Лилит').count()));
    const nav = await page.locator(`nav[aria-label="${JSON.parse(readFileSync('public/locales/ru/common.json', 'utf8')).header.bottomNav}"] a`).evaluateAll((links) => links.map((a) => a.getAttribute('href')));
    check('5.14 bottom navigation without the coins entry; favorites instead', nav.length === 5 && !nav.some((href) => /coins/.test(href)) && nav.some((href) => /favorites/.test(href)), nav);
    const balanceEl = page.locator('[data-testid="vc-balance"]').first();
    await balanceEl.waitFor();
    // The current mobile header hides the VC suffix below 400px and keeps the coin icon/title.
    const balanceState = await balanceEl.evaluate((element) => ({
      tag: element.tagName, title: element.getAttribute('title'), text: element.innerText,
      linked: Boolean(element.closest('a')),
    }));
    check('5.15 VC balance is visible and is not a link to the shop', balanceState.tag === 'SPAN'
      && balanceState.title === 'VerseCoins' && /\d/.test(balanceState.text) && !balanceState.linked, balanceState);
    const tgCalls = await page.evaluate(() => JSON.parse(sessionStorage.getItem('test:tg') || '[]'));
    check('4.1 SDK: ready, expand, palette colours for header/background/bottom bar, vertical swipes off',
      ['ready', 'expand', 'header:#0c0b12', 'bg:#0c0b12', 'bottom:#0c0b12', 'noswipe'].every((call) => tgCalls.includes(call)), tgCalls);
    check('4.2 theme from Telegram is applied to the document (dark)', await page.locator('html[data-tg-color-scheme="dark"]').count() === 1);

    const ym = await page.evaluate(() => JSON.parse(sessionStorage.getItem('test:ym') || '[]'));
    const firstInit = ym.find((entry) => entry.type === 'call' && entry.method === 'init');
    check('6.12 Metrika never sees tgWebAppData (script load, init, hits, goals)', ym.length > 0 && !JSON.stringify(ym).includes('tgWebAppData')
      && !JSON.stringify(ym).includes(encodeURIComponent('auth_date')), ym.slice(0, 3));
    check('6.13 the first Metrika call carries utm_source=telegram_miniapp and the campaign', firstInit && firstInit.args.includes('utm_source=telegram_miniapp')
      && firstInit.args.includes('utm_campaign=autumn_ad'), firstInit);
    const leaked = requests.filter((entry) => entry.url.includes('tgWebAppData') || entry.referer.includes('tgWebAppData') || entry.url.includes('auth_date%3D'));
    check('6.14 no request URL or Referer contains the launch data', leaked.length === 0, leaked.slice(0, 3));
    check('6.15 Telegram id and name are not sent to Metrika', !JSON.stringify(ym).includes(TG_BROWSER) && !JSON.stringify(ym).includes('Тест'));
    const goals = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('test:ym') || '[]').filter((entry) => entry.method === 'reachGoal').map((entry) => JSON.parse(entry.args)[0]));
    await page.waitForFunction(() => (sessionStorage.getItem('test:ym') || '').includes('register_success'), null, { timeout: 30_000 });
    await page.reload();
    await page.getByText('Вампир Лео').first().waitFor();
    await settle(page, 2500);
    const goalList = await goals();
    check('7.4 register_success is reached exactly once (not again after a reload)', goalList.filter((goal) => goal === 'register_success').length === 1, goalList);

    const findings = {};
    for (const path of ['/ru', '/ru/profile', '/ru/coins', '/ru/pricing', '/ru/chats', '/ru/favorites', '/ru/notifications', '/ru/referral', `/ru/character/${listed.slug}`, '/ru/create']) {
      await page.goto(`${base}${path}`);
      await settle(page, 2500);
      const hits = purchaseFindings(await domParts(page));
      if (hits.length) findings[path] = hits;
    }
    check('5.16 rendered pages in Telegram (after data loads) show no prices, purchase buttons or shop links', Object.keys(findings).length === 0, findings);
    await page.goto(`${base}/ru/profile`);
    await page.locator('[data-testid="daily-bonus-card"]').waitFor();
    check('5.17 profile in Telegram: daily bonus instead of the subscription block, no Telegram link card', await page.locator('[data-testid="telegram-link-card"]').count() === 0
      && !(await page.getByText('Управление подпиской').count()));
    await page.screenshot({ path: join(shots, 'profile-dark.png') });
    await page.goto(`${base}/ru/coins`);
    await page.locator('[data-testid="daily-bonus-card"]').waitFor();
    const claim = page.locator('[data-testid="daily-bonus-card"] button.wd-button');
    await claim.click();
    await page.getByText('Бонус уже получен сегодня').waitFor({ timeout: 30_000 });
    check('5.18 the daily bonus is claimed in Telegram (no email needed for a Telegram account)', true);
    await page.goto(`${base}/ru/character/${listed.slug}`);
    await settle(page, 2000);
    const afterNav = await page.evaluate(() => JSON.parse(sessionStorage.getItem('test:tg') || '[]'));
    check('4.3 Telegram back button is shown on inner pages and hidden on sections', afterNav.lastIndexOf('back:show') > afterNav.lastIndexOf('back:hide'), afterNav.slice(-6));
    await page.evaluate(() => window.__tgBack && window.__tgBack());
    await page.waitForURL((url) => !url.pathname.includes('/character/'));
    check('4.4 Telegram back button navigates back inside the app', true);
    await page.goto(`${base}/ru/chat/${listed.id}`);
    await page.locator('textarea').first().waitFor();
    await settle(page, 1500);
    await page.getByRole('button', { name: 'Как списываются VC', exact: true }).click();
    const chatHint = await page.locator('main').innerText();
    check('5.19 chat in Telegram: neutral VC rules text, composer visible at mobile width', !/оплачивается/.test(chatHint) && /списываются/.test(chatHint)
      && await page.locator('textarea').first().isVisible());
    await page.getByRole('button', { name: 'Как списываются VC', exact: true }).click();
    const vvh = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--nv-tg-vvh'));
    const shellHeight = await page.locator('.nv-chat-shell').evaluate((element) => element.getBoundingClientRect().height);
    check('4.5 chat height follows the visible viewport (keyboard-safe variable)', vvh.trim() === '844px' && Math.abs(shellHeight - (844 - 56)) <= 2, { vvh, shellHeight });
    const safeLayout = await page.evaluate(() => {
      const app = window.Telegram.WebApp;
      app.safeAreaInset = { top: 24, bottom: 16, left: 0, right: 0 };
      app.contentSafeAreaInset = { top: 48, bottom: 12, left: 0, right: 0 };
      window.__tgEvents.contentSafeAreaChanged();
      const shell = document.querySelector('.nv-chat-shell').getBoundingClientRect();
      const header = document.querySelector('.nv-app-header').getBoundingClientRect();
      return { shellTop: shell.top, shellBottom: shell.bottom, headerBottom: header.bottom };
    });
    check('Telegram safe area updates keep the header and chat inside the usable viewport', safeLayout.headerBottom === 104
      && safeLayout.shellTop >= 104 && safeLayout.shellBottom <= 828, safeLayout);
    await page.evaluate(() => {
      window.Telegram.WebApp.safeAreaInset = window.Telegram.WebApp.contentSafeAreaInset = { top: 0, bottom: 0, left: 0, right: 0 };
      window.__tgEvents.safeAreaChanged();
    });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('4.6 no horizontal scrolling at 390 px', overflow <= 0, overflow);
    await page.screenshot({ path: join(shots, 'chat-dark.png') });
    await page.goto(`${base}/ru/terms`);
    await page.getByRole('button', { name: 'Открыть в браузере' }).click();
    await page.waitForFunction(() => (sessionStorage.getItem('test:tg') || '').includes('openLink:'), null, { timeout: 30_000 }).catch(() => {});
    const opened = await page.evaluate(() => JSON.parse(sessionStorage.getItem('test:tg') || '[]').filter((call) => call.startsWith('openLink:')));
    check('5.20 documents with payment terms open only outside the app (Telegram openLink)', opened.some((call) => call.endsWith('/ru/terms')), opened);
    check('11.1 no page or console errors (dark, RU, mobile)', errors.length === 0, errors);
    await page.goto(`${base}/ru/profile`);
    await page.locator('[data-testid="telegram-account-card"]').waitFor();
    check('Telegram profile explains shared website sign-in and account management', await page.getByText('Открыть сайт', { exact: true }).count() === 1);
    await page.getByRole('button', { name: 'Меню профиля' }).click();
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await page.waitForURL(`${base}/tg/signed-out`);
    await page.locator('[data-testid="telegram-signed-out"]').waitFor();
    const signedOutSession = await context.request.get(`${base}/api/auth/session`);
    check('Telegram logout clears session and stays on an explicit signed-out screen', !(await signedOutSession.json())?.user
      && await page.getByText('Вы вышли из аккаунта', { exact: true }).count() === 1);
    await page.reload();
    await page.locator('[data-testid="telegram-signed-out"]').waitFor();
    check('reload after logout does not silently sign back in', !(await (await context.request.get(`${base}/api/auth/session`)).json())?.user);
    await page.screenshot({ path: join(shots, 'signed-out.png') });
    await context.close();
  }

  // B2. English user, light Telegram theme, iOS-like width; character deep link from startapp.
  if (!only) {
    // Deliberately mismatch the browser and Telegram languages: Telegram controls consent too.
    const { context, errors, attach } = await telegramContext({ scheme: 'light', locale: 'ru-RU' });
    const page = await context.newPage();
    attach(page);
    await page.goto(`${base}/tg#${fragment(launch('7770003', { language: 'en', startParam: 'c_leo-vampire', firstName: 'Ann' }), '&tgWebAppPlatform=ios')}`, { timeout: 180_000 });
    await page.locator('[data-testid="telegram-entry"][data-state="consent"]').waitFor({ timeout: 180_000 });
    check('11.2 English Telegram user gets the English consent screen', await page.getByRole('button', { name: 'Continue' }).count() === 1);
    for (const box of await page.locator('[data-testid="telegram-entry"] input[type=checkbox]').all()) await box.check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(`${base}/en/character/leo-vampire`, { timeout: 180_000 });
    await page.getByText('Leo the Vampire').first().waitFor();
    await settle(page, 2000);
    check('2.14 startapp c_<slug> opens the character; language EN from Telegram', page.url().endsWith('/en/character/leo-vampire'));
    check('4.7 light Telegram theme: document marked light, palette colours still applied to Telegram chrome',
      await page.locator('html[data-tg-color-scheme="light"]').count() === 1
      && (await page.evaluate(() => sessionStorage.getItem('test:tg'))).includes('header:#0c0b12'));
    const findings = purchaseFindings(await domParts(page));
    check('5.21 English character page in Telegram has no purchase elements', findings.length === 0, findings);
    await page.screenshot({ path: join(shots, 'character-light-en.png') });
    await page.goto(`${base}/en`);
    await settle(page, 2000);
    const homeEn = purchaseFindings(await domParts(page));
    check('5.22 English catalog in Telegram has no purchase elements', homeEn.length === 0, homeEn);
    check('11.3 no page or console errors (light, EN, mobile)', errors.length === 0, errors);
    await context.close();
  }

  // B3. Telegram Web: the app inside a cross-site frame. Only the partitioned cookie can work there.
  {
    const host = 'https://web.telegram.org';
    const frameUrl = `${base}/tg#${fragment(launch(TG_HTTP))}`;
    const hostPage = { origin: host, html: `<!doctype html><title>Telegram Web</title><iframe id="app" src="${frameUrl}" style="width:390px;height:800px;border:0"></iframe>` };
    // Test-only: Chromium's Local Network Access check blocks an https page (the emulated Telegram Web)
    // from framing http://localhost. Real Telegram Web frames the https site, so it is switched off here.
    frameBrowser = await chromium.launch({ headless: true, args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessForNavigations,PrivateNetworkAccessForWorkers'],
      ...(process.env['GUEST_TEST_BROWSER_CHANNEL'] ? { channel: process.env['GUEST_TEST_BROWSER_CHANNEL'] } : {}) });
    const { context, errors, attach } = await telegramContext({ mobile: false, hostPage, using: frameBrowser });
    const page = await context.newPage();
    attach(page);
    const hostConsole = [];
    page.on('console', (message) => hostConsole.push(message.text().slice(0, 300)));
    await page.goto(`${host}/k/`, { timeout: 180_000 });
    const frame = await (await page.waitForSelector('#app')).contentFrame();
    try {
      await frame.waitForURL(`${base}/ru`, { timeout: 180_000 });
    } catch (error) {
      const state = await frame.evaluate(() => ({ url: location.href, text: document.body?.innerText?.slice(0, 300), origin: location.origin, state: document.querySelector('[data-testid=telegram-entry]')?.getAttribute('data-state') })).catch((e) => String(e));
      await page.screenshot({ path: join(shots, 'frame-failure.png') }).catch(() => {});
      console.error('frame state', JSON.stringify(state), errors, hostConsole);
      throw error;
    }
    await frame.getByText('Вампир Лео').first().waitFor();
    const framed = await frame.evaluate(async () => (await (await fetch('/api/auth/session')).json()));
    const browserUser = await db.user.findFirst({ where: { telegramAccount: { telegramId: TG_HTTP } } });
    check('8.8 Telegram Web frame: the existing user is signed in through the partitioned cookie', framed?.user?.id === browserUser.id, framed);
    const cookies = await context.cookies(base);
    const tgCookie = cookies.find((cookie) => cookie.name === 'nv-tg.session-token');
    check('8.9 the framed session cookie is Partitioned, SameSite=None, Secure, HttpOnly', tgCookie && tgCookie.sameSite === 'None' && tgCookie.secure && tgCookie.httpOnly
      && (tgCookie.partitionKey === host || tgCookie.partitionKey?.topLevelSite === host || tgCookie.partitionKey !== undefined), tgCookie);
    const siteCookie = cookies.find((cookie) => /next-auth\.session-token/.test(cookie.name) && !cookie.partitionKey);
    check('8.10 no unpartitioned site session cookie is created by the frame', !siteCookie);
    check('11.4 no page or console errors in the Telegram Web frame', errors.length === 0, errors);
    await context.close();
  }

  // B4. A foreign site cannot frame the Telegram context (frame-ancestors).
  {
    const host = 'https://evil.example';
    const hostPage = { origin: host, html: `<!doctype html><iframe id="app" src="${base}/tg"></iframe>` };
    // Same browser as B3 (Local Network Access check off), so only frame-ancestors can block the frame.
    const { context } = await telegramContext({ mobile: false, hostPage, using: frameBrowser ?? browser });
    const page = await context.newPage();
    const blockedMessages = [];
    page.on('console', (message) => { if (/frame-ancestors/.test(message.text())) blockedMessages.push(message.text()); });
    await page.goto(`${host}/`, { timeout: 120_000 });
    await page.waitForTimeout(8000);
    const frame = await (await page.waitForSelector('#app')).contentFrame();
    const content = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    check('8.11 a non-Telegram site cannot embed the Mini App', !content.includes('NewVerse') && blockedMessages.length > 0, { blockedMessages, content: content.slice(0, 80) });
    await context.close();
  }

  // B5. The website in a normal browser is unchanged: shop works, no Telegram SDK is loaded.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const sdkRequests = [];
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.includes('telegram.org')) sdkRequests.push(url);
      return url.startsWith(base) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    await page.goto(`${base}/ru/login`);
    await page.locator('input[type=email]').fill(siteUser.email);
    await page.locator('input[type=password]').fill('SiteTest123!');
    await page.locator('#login-submit').click();
    await page.waitForURL((url) => !url.pathname.endsWith('/login'));
    await page.goto(`${base}/ru/coins`);
    await page.locator('[data-action="open-checkout"]').first().waitFor();
    check('5.23 website: the shop shows purchase buttons and prices as before', await page.locator('[data-action="open-checkout"]').count() > 0
      && /₽/.test(await page.locator('main').innerText()));
    await page.goto(`${base}/ru/profile`);
    await page.locator('[data-testid="telegram-link-card"]').waitFor();
    check('3.20 website profile shows the "Link Telegram" card', await page.getByRole('button', { name: 'Привязать Telegram' }).count() === 1);
    check('4.8 the website never loads the Telegram SDK and has no Telegram mode', sdkRequests.length === 0 && await page.locator('html[data-telegram]').count() === 0, sdkRequests);
    await context.close();
  }

  // B6. A Telegram-only account can use the same profile in an ordinary browser.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    await page.goto(`${base}/ru/login`);
    await page.getByRole('button', { name: 'Войти через Telegram', exact: true }).click();
    const botLink = page.getByRole('link', { name: 'Открыть бота для подтверждения' });
    await botLink.waitFor();
    const payload = new URL(await botLink.getAttribute('href')).searchParams.get('start');
    const usersBefore = await db.user.count();
    const botCommand = async text => request('/api/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
      body: JSON.stringify({ message: { text: `/start ${text}`, chat: { id: Number(TG_HTTP), type: 'private' }, from: { id: Number(TG_HTTP), language_code: 'ru' } } }) });
    const ask = await (await botCommand(payload)).json();
    const confirmation = new URL(ask.reply_markup.inline_keyboard[0][0].url).searchParams.get('start');
    check('website login starts with a browser-bound request and bot consent', /Код запроса/.test(ask.text)
      && await page.getByRole('button', { name: 'Войти в этот аккаунт' }).count() === 0);
    await botCommand(confirmation);
    const complete = page.getByRole('button', { name: 'Войти в этот аккаунт' });
    await complete.waitFor();
    await page.screenshot({ path: join(shots, 'website-telegram-login.png') });
    await complete.click();
    await page.waitForURL(`${base}/ru`);
    const session = await (await context.request.get(`${base}/api/auth/session`)).json();
    check('real NextAuth callback signs browser into the existing Telegram user', session.user?.id === httpUser.id && !session.user?.oauthRegistrationUserId);
    check('browser sign-in creates neither a second user nor a Mini App context cookie', await db.user.count() === usersBefore
      && !(await context.cookies()).some(c => /nv-tg.ctx/.test(c.name)));
    await context.close();
  }

  console.log(`\nverify:telegram:server — ${passed} passed. Screenshots: ${shots}`);
} catch (error) {
  console.error(log.split('\n').filter((line) => /error|warn|fail/i.test(line)).slice(-40).join('\n'));
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await frameBrowser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true });
    else server.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await h.stop();
}
