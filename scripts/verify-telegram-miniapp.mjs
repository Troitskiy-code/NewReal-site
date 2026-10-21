// Telegram Mini App: isolated acceptance checks of the server side.
// Embedded PostgreSQL (GUEST_TEST_RUNTIME) via the memory harness, fake AI provider, a bot token and
// webhook secret generated here. Never loads .env, never calls Telegram or an AI provider.
// Run: npm run verify:telegram
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import vm from 'node:vm';
import { startHarness } from './lib/memory-test-harness.mjs';

const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const { decode } = require('next-auth/jwt');

let passed = 0;
const check = (name, condition, details) => {
  if (!condition) {
    console.error(`FAIL ${name}${details === undefined ? '' : ` ${JSON.stringify(details)}`}`);
    throw new Error(`Check failed: ${name}`);
  }
  passed += 1;
  console.log(`PASS ${name}`);
};

// Request scope of src/lib/telegram/context.ts: the test decides whether the request is in Telegram.
const telegramRequest = { context: false };
globalThis.__nvTelegramTestRequest = {
  cookies: async () => ({ get: (name) => (telegramRequest.context && /nv-tg\.ctx$/.test(name) ? { name, value: '1' } : undefined) }),
  headers: async () => new Headers(),
};
const h = await startHarness({
  label: 'telegram',
  sourceTransform: (file, source) => file.replaceAll('\\', '/').endsWith('src/lib/telegram/context.ts')
    ? source.replace('import { cookies, headers } from "next/headers";', 'const { cookies, headers } = globalThis.__nvTelegramTestRequest;')
    : source,
});
const { db, load, root, session } = h;

const BOT_TOKEN = `${700000000 + Math.floor(Math.random() * 1e8)}:${randomBytes(27).toString('base64url')}`;
const OTHER_TOKEN = `${700000000 + Math.floor(Math.random() * 1e8)}:${randomBytes(27).toString('base64url')}`;
const WEBHOOK_SECRET = randomBytes(24).toString('base64url');
Object.assign(process.env, {
  TELEGRAM_MINIAPP_ENABLED: '1', TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  TELEGRAM_BOT_USERNAME: 'nv_synthetic_bot', NEXTAUTH_URL: 'http://localhost:3000', CHAT_THREADS_ENABLED: '1',
});

const src = (path) => load(join(root, 'src', path));
const initDataLib = src('lib/telegram/initData.ts');
const shared = src('lib/telegram/shared.ts');
const { TELEGRAM_LAUNCH_SCRIPT } = src('lib/telegram/launchScript.ts');
const authRoute = src('app/api/telegram/auth/route.ts');
const webhookRoute = src('app/api/telegram/webhook/route.ts');
const linkRoute = src('app/api/telegram/link/route.ts');
const accounts = src('lib/telegram/accounts.ts');
const { SIGNUP_VC_GRANT } = src('lib/provisionNewUser.ts');

const now = () => Math.floor(Date.now() / 1000);
let launchSeq = 0;
function launch(telegramId, { token = BOT_TOKEN, authDate = now(), language = 'ru', startParam, firstName = 'Тест', extra = {} } = {}) {
  launchSeq += 1;
  const fields = {
    query_id: `AAH${launchSeq}${randomBytes(6).toString('hex')}`,
    // Raw JSON as Telegram sends it: the numeric id may exceed Number.MAX_SAFE_INTEGER.
    user: `{"id":${telegramId},"first_name":${JSON.stringify(firstName)},"language_code":"${language}","allows_write_to_pm":true}`,
    auth_date: String(authDate),
    ...(startParam ? { start_param: startParam } : {}),
    ...extra,
  };
  return initDataLib.signInitData(fields, token);
}

const SITE = 'http://localhost:3000';
function authRequest(body, { origin = SITE, cookie = '', contentType = 'application/json' } = {}) {
  return new NextRequest(`${SITE}/api/telegram/auth`, {
    method: 'POST',
    headers: { 'content-type': contentType, host: 'localhost:3000', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}
async function auth(body, options) {
  const response = await authRoute.POST(authRequest(body, options));
  return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
}
async function webhook(update, secret = WEBHOOK_SECRET) {
  const response = await webhookRoute.POST(new NextRequest(`${SITE}/api/telegram/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
    body: JSON.stringify(update),
  }));
  return { status: response.status, body: await response.json() };
}
const startUpdate = (telegramId, text, extra = {}) => ({
  update_id: launchSeq++, message: { message_id: 1, text, chat: { id: Number(telegramId), type: 'private' },
    from: { id: Number(telegramId), is_bot: false, first_name: 'Тест', language_code: 'ru' }, ...extra },
});
async function linkCall(method, userId, headers = { 'sec-fetch-site': 'same-origin' }) {
  session.userId = userId;
  const response = await linkRoute[method](new NextRequest(`${SITE}/api/telegram/link`, { method, headers }));
  session.userId = null;
  return { status: response.status, body: await response.json() };
}
const counts = async () => ({
  users: await db.user.count(), accounts: await db.telegramAccount.count(), receipts: await db.telegramInitDataReceipt.count(),
  tokens: await db.telegramLinkToken.count({ where: { usedAt: { not: null } } }),
});

try {
  // ---------------------------------------------------------------------------------------------
  // 1. initData validation
  // ---------------------------------------------------------------------------------------------
  {
    const valid = launch('9007199254740993', { startParam: 'promo__c_leo' });
    const result = initDataLib.verifyInitData(valid, BOT_TOKEN);
    check('1.1 valid signature passes and keeps a Telegram id above 2^53 exact', result.ok && result.user.id === '9007199254740993'
      && result.startParam === 'promo__c_leo' && /^[0-9a-f]{64}$/.test(result.replayKey), result);
    check('1.2 signature made with another bot token is rejected', initDataLib.verifyInitData(launch('42', { token: OTHER_TOKEN }), BOT_TOKEN).reason === 'signature');
    const tampered = new URLSearchParams(launch('42'));
    tampered.set('user', JSON.stringify({ id: 43, first_name: 'Тест', language_code: 'ru' }));
    check('1.3 a changed field (user id) breaks the signature', initDataLib.verifyInitData(tampered.toString(), BOT_TOKEN).reason === 'signature');
    const startChanged = new URLSearchParams(launch('42', { startParam: 'a' }));
    startChanged.set('start_param', 'c_other');
    check('1.4 a changed start_param breaks the signature', initDataLib.verifyInitData(startChanged.toString(), BOT_TOKEN).reason === 'signature');
    check('1.5 auth_date older than the limit is rejected', initDataLib.verifyInitData(launch('42', { authDate: now() - 3601 }), BOT_TOKEN).reason === 'expired');
    check('1.6 auth_date in the future is rejected', initDataLib.verifyInitData(launch('42', { authDate: now() + 600 }), BOT_TOKEN).reason === 'expired');
    check('1.7 a repeated field is rejected as malformed', initDataLib.verifyInitData(`${launch('42')}&auth_date=${now()}`, BOT_TOKEN).reason === 'malformed');
    check('1.8 missing or malformed hash, empty and oversized input are rejected',
      ['', 'auth_date=1', launch('42').replace(/hash=[0-9a-f]+/, 'hash=zz'), 'a='.padEnd(5000, 'x')].every((value) => !initDataLib.verifyInitData(value, BOT_TOKEN).ok));
    const botUser = initDataLib.signInitData({ user: JSON.stringify({ id: 5, is_bot: true, first_name: 'Bot' }), auth_date: String(now()) }, BOT_TOKEN);
    check('1.9 a bot as the launching user is rejected', initDataLib.verifyInitData(botUser, BOT_TOKEN).reason === 'user');
    check('1.10 the same initData has the same replay key, another launch a different one',
      initDataLib.verifyInitData(valid, BOT_TOKEN).replayKey === result.replayKey
      && initDataLib.verifyInitData(launch('9007199254740993'), BOT_TOKEN).replayKey !== result.replayKey);
  }

  // ---------------------------------------------------------------------------------------------
  // Launch script (inline <head>) and start parameters
  // ---------------------------------------------------------------------------------------------
  function runLaunchScript(href) {
    const url = new URL(href);
    const storage = new Map();
    const location = {
      get href() { return url.href; }, get hash() { return url.hash; }, get search() { return url.search; }, get pathname() { return url.pathname; },
      replaced: null, replace(next) { this.replaced = next; },
    };
    const window = { location };
    const sandbox = {
      window, URLSearchParams,
      sessionStorage: { setItem: (key, value) => storage.set(key, value), getItem: (key) => storage.get(key) ?? null },
      history: { state: null, replaceState: (_state, _title, next) => { const target = new URL(next, url); url.pathname = target.pathname; url.search = target.search; url.hash = ''; } },
    };
    window.history = sandbox.history;
    vm.runInNewContext(TELEGRAM_LAUNCH_SCRIPT, sandbox);
    return { url, storage, launch: window.__nvTgLaunch, replaced: location.replaced };
  }
  {
    const data = launch('77', { startParam: 'spring_ad__c_leo-vampire' });
    const fragment = `tgWebAppData=${encodeURIComponent(data)}&tgWebAppVersion=8.0&tgWebAppPlatform=ios&tgWebAppThemeParams=%7B%7D`;
    const run = runLaunchScript(`${SITE}/tg#${fragment}`);
    check('6.1 launch script removes tgWebAppData from the address before any other script', !run.url.href.includes('tgWebAppData') && run.url.hash === '');
    check('6.2 the address gets utm_source=telegram_miniapp and the startapp campaign',
      run.url.pathname === '/tg' && run.url.searchParams.get('utm_source') === 'telegram_miniapp'
      && run.url.searchParams.get('utm_medium') === 'miniapp' && run.url.searchParams.get('utm_campaign') === 'spring_ad', run.url.href);
    const stored = JSON.parse(run.storage.get('__telegram__initParams'));
    check('6.3 launch data stays available to the Telegram SDK (its sessionStorage key) and the entry page',
      stored.tgWebAppData === data && stored.tgWebAppVersion === '8.0' && run.launch.initData === data);
    const bot = runLaunchScript(`${SITE}/tg?tgsrc=channel_post#tgWebAppData=${encodeURIComponent(launch('77'))}`);
    check('6.4 the bot button label (?tgsrc=) becomes utm_campaign and is removed', bot.url.searchParams.get('utm_campaign') === 'channel_post' && !bot.url.searchParams.has('tgsrc'));
    const elsewhere = runLaunchScript(`${SITE}/ru/chats#tgWebAppData=${encodeURIComponent(launch('77'))}`);
    check('6.5 a launch on another path is cleaned first and sent to /tg', elsewhere.url.href === `${SITE}/ru/chats` && elsewhere.replaced?.startsWith('/tg?utm_source=telegram_miniapp'));
    const plain = runLaunchScript(`${SITE}/ru/chats#section`);
    check('6.6 without launch data the script changes nothing', plain.url.href === `${SITE}/ru/chats#section` && plain.storage.size === 0);
    const cases = ['', 'promo', 'c_leo', 'promo__c_leo', 'c_leo__promo', 'link_abc', 'login_secret', 'login_ok_secret', 'merge_confirm_secret', 'ref_ABC123', 'promo__ref_ABC123__c_leo', 'bad!value', 'a'.repeat(65), 'x__y', 'c_Leo-1__ad_2'];
    const agree = cases.every((value) => {
      const script = runLaunchScript(`${SITE}/tg#tgWebAppData=${encodeURIComponent(launch('77', value ? { startParam: value } : {}))}`).url.searchParams.get('utm_campaign');
      return (script ?? null) === shared.parseTelegramStartParam(value).campaign;
    });
    check('6.7 inline script and parseTelegramStartParam agree on campaign labels', agree);
    check('6.8 start parameter grammar: campaign and character', JSON.stringify(shared.parseTelegramStartParam('promo__c_Leo-1'))
      === JSON.stringify({ campaign: 'promo', characterSlug: 'leo-1' }) && shared.parseTelegramStartParam('c_../x').characterSlug === null);
    const attribution = src('lib/paymentAttribution.ts');
    const touch = attribution.visitTouchFromUrl(run.url.href, '');
    check('7.1 the cleaned URL is recorded by the existing first/last attribution', touch?.utm_source === 'telegram_miniapp' && touch?.utm_campaign === 'spring_ad'
      && attribution.updateVisitAttribution(null, touch)?.firstTouch?.utm_source === 'telegram_miniapp');
    const urlPrivacy = src('lib/urlPrivacy.ts');
    check('6.9 analytics URL of a raw launch address never contains the launch data',
      !urlPrivacy.analyticsUrl(`${SITE}/tg#${fragment}`, `${SITE}/tg#${fragment}`).includes('tgWebAppData'));
    const redact = src('lib/redactSensitive.ts');
    check('6.10 log redaction removes initData from URLs and JSON bodies',
      !redact.redactText(`GET /tg#${fragment}`).includes(encodeURIComponent(data).slice(0, 40))
      && !redact.redactText(JSON.stringify({ initData: data })).includes('hash='));
  }
  check('5.1 shop pages, payment documents and purchase APIs are classified for the Telegram context',
    ['/coins', '/pricing', '/subscription', '/subscription/x', '/tokens', '/realcoins', '/balance'].every(shared.isTelegramPurchasePath)
    && ['/offer', '/refund', '/terms', '/privacy'].every(shared.isTelegramExternalDocPath)
    && ['/api/payment/create', '/api/subscription/create', '/api/coins/offer', '/api/checkout', '/api/billing/checkout'].every(shared.isTelegramPurchaseApiPath)
    && !['/', '/chats', '/rules', '/coinsx', '/api/payment/webhook', '/api/user/balance'].some((path) => shared.isTelegramPurchasePath(path) || shared.isTelegramPurchaseApiPath(path)));

  // ---------------------------------------------------------------------------------------------
  // 4. Webhook secret
  // ---------------------------------------------------------------------------------------------
  {
    const before = await counts();
    const noSecret = await webhook(startUpdate('100', '/start'), null);
    const wrong = await webhook(startUpdate('100', '/start'), `${WEBHOOK_SECRET.slice(0, -1)}x`);
    const site = await db.user.create({ data: { email: 'webhook-probe@example.test', password: 'x' } });
    const { token } = await accounts.createLinkToken(site.id);
    const linkWithoutSecret = await webhook(startUpdate('101', `/start link_${token}`), null);
    const after = await counts();
    check('4.1 webhook without or with a wrong secret answers 401', noSecret.status === 401 && wrong.status === 401 && linkWithoutSecret.status === 401);
    check('4.2 a rejected webhook has no side effects (link token unused, no accounts)', after.accounts === before.accounts && after.tokens === before.tokens
      && (await db.telegramLinkToken.findFirst({ where: { userId: site.id } })).usedAt === null);
    const start = await webhook(startUpdate('100', '/start'));
    const button = start.body.reply_markup?.inline_keyboard?.[0]?.[0];
    check('bot /start answers with a Mini App button to /tg', start.status === 200 && start.body.method === 'sendMessage' && start.body.chat_id === 100
      && button?.web_app?.url === `${SITE}/tg`, start.body);
    const promo = await webhook(startUpdate('100', '/start autumn_promo'));
    check('bot /start <label> passes the campaign to the Mini App', promo.body.reply_markup.inline_keyboard[0][0].web_app.url === `${SITE}/tg?tgsrc=autumn_promo`);
    const referral = await webhook(startUpdate('100', '/start ref_ABC123'));
    check('bot referral launch preserves the referral code without treating it as a campaign', referral.body.reply_markup.inline_keyboard[0][0].web_app.url === `${SITE}/tg?ref=ABC123`);
    const help = await webhook(startUpdate('100', '/help'));
    const privacy = await webhook(startUpdate('100', '/privacy@nv_synthetic_bot'));
    check('bot /help and /privacy lead to the rules and privacy policy', JSON.stringify(help.body).includes('/ru/rules')
      && privacy.body.reply_markup.inline_keyboard[0][0].url === `${SITE}/ru/privacy`);
    const group = await webhook({ update_id: 1, message: { text: '/start', chat: { id: -5, type: 'group' }, from: { id: 100, is_bot: false } } });
    check('bot ignores groups (no reply)', group.status === 200 && group.body.ok === true && !group.body.method);
    const noReplyText = JSON.stringify([start.body, promo.body, help.body, privacy.body]);
    check('5.2 bot messages contain no price, shop or payment link', !/₽|руб|RUB|\$|купи|пополн|тариф|оплат|\/coins|\/pricing|robokassa/i.test(noReplyText));
    process.env.TELEGRAM_MINIAPP_ENABLED = '0';
    const off = await webhook(startUpdate('100', '/start'));
    process.env.TELEGRAM_MINIAPP_ENABLED = '1';
    check('flag off: webhook answers 404', off.status === 404);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. First sign-in creates a user with the site start balance; next one finds the same user
  // ---------------------------------------------------------------------------------------------
  const TG_NEW = '5550001';
  let newUserId;
  {
    const before = await counts();
    const first = launch(TG_NEW, { firstName: 'Аня' });
    const consent = await auth({ initData: first });
    const mid = await counts();
    check('2.1 a new Telegram user is asked for consent first; nothing is created or consumed', consent.status === 200
      && consent.body.status === 'consent_required' && mid.users === before.users && mid.receipts === before.receipts);
    check('5.3 the consent response already sets the Telegram context cookie (purchases hidden)',
      consent.cookies.some((cookie) => cookie.startsWith('nv-tg.ctx=1')) && !consent.cookies.some((cookie) => cookie.startsWith('nv-tg.session-token=')));
    const created = await auth({ initData: first, consent: true });
    const user = await db.user.findFirst({ where: { telegramAccount: { telegramId: TG_NEW } }, include: { transactions: true, telegramAccount: true } });
    newUserId = user?.id;
    check('2.2 consent creates the user, signs in and opens the catalog', created.status === 200 && created.body.status === 'ok'
      && created.body.isNew === true && created.body.redirect === '/ru', created.body);
    check('2.3 the new user has the same start VC and plan as a site registration', user.verseCoins === SIGNUP_VC_GRANT && user.permanentCoins === SIGNUP_VC_GRANT
      && user.subscriptionType === 'start' && user.transactions.some((row) => row.type === 'signup_bonus' && row.amount === SIGNUP_VC_GRANT), { coins: user.verseCoins });
    check('2.4 consent timestamps are stored, Telegram name used, no email', user.acceptedTermsAt && user.acceptedPrivacyAt && user.name === 'Аня' && user.email === null
      && user.telegramAccount.origin === 'telegram');
    const sessionCookie = created.cookies.find((cookie) => cookie.startsWith('nv-tg.session-token='));
    const contextCookie = created.cookies.find((cookie) => cookie.startsWith('nv-tg.ctx='));
    check('8.1 Telegram cookies are HttpOnly; Secure; SameSite=None; Partitioned', [sessionCookie, contextCookie].every((cookie) => cookie
      && /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=none/i.test(cookie) && /Partitioned/i.test(cookie) && /Path=\//.test(cookie)), created.cookies);
    const jwt = await decode({ token: sessionCookie.split(';')[0].split('=').slice(1).join('='), secret: process.env.NEXTAUTH_SECRET });
    check('2.5 the session is an ordinary NextAuth JWT of this user with the Telegram account id',
      jwt?.sub === user.id && jwt?.id === user.id && jwt?.telegramAccountId === user.telegramAccount.id && jwt.exp - jwt.iat === 30 * 86400, jwt);
    check('2.6 initData is not part of the session token or the response', !JSON.stringify(jwt).includes('hash') && !JSON.stringify(created.body).includes('hash'));

    const replay = await auth({ initData: first, consent: true });
    check('1.11 replay of used initData without a session is rejected', replay.status === 401 && replay.body.status === 'replay');
    session.userId = user.id;
    const reload = await auth({ initData: first });
    session.userId = null;
    check('1.12 reload with the same launch and its own session is accepted without a new session', reload.status === 200 && reload.body.status === 'ok'
      && !reload.cookies.some((cookie) => cookie.startsWith('nv-tg.session-token=')));
    const again = await auth({ initData: launch(TG_NEW, { startParam: 'c_leo-vampire', language: 'en' }) });
    check('2.7 a later launch finds the same user (no new user, no second bonus)', again.body.status === 'ok' && again.body.isNew === false
      && (await db.user.count({ where: { telegramAccount: { telegramId: TG_NEW } } })) === 1
      && (await db.transaction.count({ where: { userId: user.id, type: 'signup_bonus' } })) === 1);
    check('2.8 startapp c_<slug> opens that character; language follows Telegram (en)', again.body.redirect === '/en/character/leo-vampire', again.body);
    const saved = await auth({ initData: launch(TG_NEW, { language: 'en' }) }, { cookie: 'NEXT_LOCALE=ru' });
    check('2.9 a language chosen with the switcher wins over Telegram language', saved.body.redirect === '/ru');
    const expired = await auth({ initData: launch(TG_NEW, { authDate: now() - 7200 }) });
    check('1.13 expired auth_date gets no session', expired.status === 401 && expired.body.status === 'expired'
      && !expired.cookies.some((cookie) => cookie.startsWith('nv-tg.session-token=')));
    const forged = await auth({ initData: launch(TG_NEW, { token: OTHER_TOKEN }) });
    check('1.14 a forged signature gets 401 and no cookies at all', forged.status === 401 && forged.cookies.length === 0);
    const crossSite = await auth({ initData: launch(TG_NEW) }, { origin: 'https://evil.example' });
    const noJson = await auth({ initData: launch(TG_NEW) }, { contentType: 'text/plain' });
    check('auth endpoint refuses cross-site requests and non-JSON bodies', crossSite.status === 403 && noJson.status === 403);

    const TG_RACE = '5550099';
    const raced = await Promise.all([auth({ initData: launch(TG_RACE), consent: true }), auth({ initData: launch(TG_RACE), consent: true })]);
    check('2.10 two parallel first launches create exactly one user', raced.every((row) => row.body.status === 'ok')
      && (await db.telegramAccount.count({ where: { telegramId: TG_RACE } })) === 1
      && (await db.user.count({ where: { telegramAccount: { telegramId: TG_RACE } } })) === 1);
    process.env.TELEGRAM_MINIAPP_ENABLED = '0';
    const off = await auth({ initData: launch(TG_NEW) });
    process.env.TELEGRAM_MINIAPP_ENABLED = '1';
    check('flag off: Telegram sign-in answers 404', off.status === 404);
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Linking an existing site account
  // ---------------------------------------------------------------------------------------------
  {
    const site = await db.user.create({ data: { email: 'site-owner@example.test', password: 'hash', verseCoins: 777, name: 'Сайт' } });
    const status0 = await linkCall('GET', site.id);
    check('3.1 profile shows "not linked" for a site account', status0.status === 200 && status0.body.enabled && !status0.body.linked);
    const created = await linkCall('POST', site.id);
    const token = created.body.url?.match(/start=link_([A-Za-z0-9_-]+)$/)?.[1];
    check('3.2 link button returns t.me/<bot>?start=link_<token> (token is not stored in plain text)', created.status === 200
      && created.body.url.startsWith('https://t.me/nv_synthetic_bot?start=link_') && token
      && !(await db.telegramLinkToken.findFirst({ where: { tokenHash: token } })), created.body);
    const crossSite = await linkCall('POST', site.id, { 'sec-fetch-site': 'cross-site' });
    check('3.3 link creation refuses cross-site requests', crossSite.status === 403);
    telegramRequest.context = true;
    const insideTelegram = await linkCall('POST', site.id);
    telegramRequest.context = false;
    check('3.4 linking is started on the website, not inside Telegram', insideTelegram.status === 409);

    const TG_SITE = '6660001';
    const linked = await webhook(startUpdate(TG_SITE, `/start link_${token}`));
    const account = await db.telegramAccount.findUnique({ where: { telegramId: TG_SITE } });
    check('3.5 /start link_<token> links the Telegram account to the site user', linked.status === 200 && account?.userId === site.id
      && account.origin === 'site' && /привязан/.test(linked.body.text) && linked.body.reply_markup.inline_keyboard[0][0].web_app);
    const reused = await webhook(startUpdate('6660002', `/start link_${token}`));
    check('3.6 the token is single-use: a second use is rejected', /недействительна/.test(reused.body.text)
      && !(await db.telegramAccount.findUnique({ where: { telegramId: '6660002' } })));
    const viaApp = await auth({ initData: launch(TG_SITE) });
    check('3.7 the Mini App now signs in to the site account (shared account and VC balance)', viaApp.body.status === 'ok' && viaApp.body.isNew === false
      && (await decode({ token: viaApp.cookies.find((c) => c.startsWith('nv-tg.session-token=')).split(';')[0].split('=').slice(1).join('='), secret: process.env.NEXTAUTH_SECRET })).sub === site.id);
    const status1 = await linkCall('GET', site.id);
    check('3.8 profile shows the link and allows unlinking (password exists)', status1.body.linked && status1.body.canUnlink && status1.body.linkedAt);

    // Expired token, a token of a user whose Telegram is taken by another account, a user with another Telegram.
    const other = await db.user.create({ data: { email: 'other@example.test', password: 'hash' } });
    const expiredToken = (await linkCall('POST', other.id)).body.url.split('link_')[1];
    await db.telegramLinkToken.updateMany({ where: { userId: other.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await webhook(startUpdate('6660003', `/start link_${expiredToken}`));
    check('3.9 an expired token is rejected', /недействительна/.test(expired.body.text) && !(await db.telegramAccount.findUnique({ where: { telegramId: '6660003' } })));
    const takenToken = (await linkCall('POST', other.id)).body.url.split('link_')[1];
    const taken = await webhook(startUpdate(TG_NEW, `/start link_${takenToken}`));
    check('3.10 an unused Telegram profile is not moved without explicit confirmation', /Подтвердите переход/.test(taken.body.text)
      && (await db.telegramAccount.findUnique({ where: { telegramId: TG_NEW } })).userId === newUserId);
    const secondToken = (await linkCall('POST', site.id));
    check('3.11 an already linked account cannot create another link', secondToken.status === 409);
    const foreignToken = (await linkCall('POST', other.id)).body.url.split('link_')[1];
    await webhook(startUpdate('6660004', `/start link_${foreignToken}`));
    const replacing = (await linkCall('POST', other.id));
    check('3.12 a token is bound to its user: using it links only that user', (await db.telegramAccount.findUnique({ where: { telegramId: '6660004' } })).userId === other.id
      && replacing.status === 409);
    const ownTokens = await db.telegramLinkToken.findMany({ where: { userId: site.id } });
    check('3.13 only one link token per user is ever active', ownTokens.filter((row) => !row.usedAt && row.expiresAt > new Date()).length <= 1);

    // Unlink: the account stays, Telegram sign-in is disabled until a new link; sessions are revoked.
    const sessionAccountId = (await db.telegramAccount.findUnique({ where: { telegramId: TG_SITE } })).id;
    check('3.14 an active Telegram session is valid before unlinking', await accounts.isTelegramSessionActive(sessionAccountId, site.id));
    const unlinked = await linkCall('DELETE', site.id);
    const row = await db.telegramAccount.findUnique({ where: { telegramId: TG_SITE } });
    check('3.15 unlink keeps the account and the Telegram row without a user', unlinked.status === 200 && row.userId === null && row.unlinkedAt
      && (await db.user.findUnique({ where: { id: site.id } })).verseCoins === 777);
    check('3.16 sessions issued by that Telegram launch are revoked', !(await accounts.isTelegramSessionActive(sessionAccountId, site.id)));
    const usersBefore = await db.user.count();
    const disabled = await auth({ initData: launch(TG_SITE), consent: true });
    check('3.17 after unlinking, Telegram sign-in is refused and no new user is created', disabled.status === 403 && disabled.body.status === 'login_disabled'
      && (await db.user.count()) === usersBefore);
    const tgOnly = await linkCall('DELETE', newUserId);
    check('3.18 Telegram cannot be unlinked when it is the only way to sign in', tgOnly.status === 409 && tgOnly.body.error === 'only_login_method');
    const relinkToken = (await linkCall('POST', site.id)).body.url.split('link_')[1];
    await webhook(startUpdate(TG_SITE, `/start link_${relinkToken}`));
    const relinked = await auth({ initData: launch(TG_SITE) });
    check('3.19 a new link turns Telegram sign-in on again for the same account', relinked.body.status === 'ok'
      && (await db.telegramAccount.findUnique({ where: { telegramId: TG_SITE } })).userId === site.id);
    const newAccount = await db.telegramAccount.findUnique({ where: { telegramId: TG_SITE } });
    accounts.forgetTelegramSessionCache();
    check('old sessions stay revoked after relinking, including after the session cache is cleared', newAccount.id !== sessionAccountId
      && !(await accounts.isTelegramSessionActive(sessionAccountId, site.id)) && await accounts.isTelegramSessionActive(newAccount.id, site.id));
  }

  // A first Mini App registration must not trap an existing website customer in a second account.
  {
    const TG_UNUSED = '6661001';
    await auth({ initData: launch(TG_UNUSED), consent: true });
    const before = await db.telegramAccount.findUnique({ where: { telegramId: TG_UNUSED } });
    const sourceId = before.userId;
    const site = await db.user.create({ data: { email: 'existing-owner@example.test', password: 'hash', name: 'Владелец сайта', verseCoins: 777 } });
    const token = (await linkCall('POST', site.id)).body.url.split('link_')[1];
    const prompt = await webhook(startUpdate(TG_UNUSED, `/start link_${token}`));
    const confirmation = prompt.body.reply_markup?.inline_keyboard[0][0].url?.split('start=link_confirm_')[1];
    check('empty Telegram profile requires a separate confirmation naming the website account', Boolean(confirmation)
      && /Владелец сайта/.test(prompt.body.text) && /ex\*\*\*@example.test/.test(prompt.body.text)
      && /не переносятся/.test(prompt.body.text)
      && (await db.telegramAccount.findUnique({ where: { telegramId: TG_UNUSED } })).userId === sourceId, prompt.body.text);
    check('confirmation fits Telegram start payload and is not stored in plaintext', `link_confirm_${confirmation}`.length <= 64
      && !(await db.telegramLinkToken.findFirst({ where: { tokenHash: confirmation } })));
    const stolen = await webhook(startUpdate('6661999', `/start link_confirm_${confirmation}`));
    check('another Telegram user cannot confirm the transfer or consume its confirmation', /недействительна/.test(stolen.body.text)
      && !(await db.telegramAccount.findUnique({ where: { telegramId: '6661999' } })));
    const linked = await webhook(startUpdate(TG_UNUSED, `/start link_confirm_${confirmation}`));
    const after = await db.telegramAccount.findUnique({ where: { telegramId: TG_UNUSED } });
    check('confirmed empty profile switches to the existing website account', /привязан/.test(linked.body.text)
      && after.userId === site.id && after.origin === 'site' && after.id !== before.id);
    check('the website balance is unchanged and the empty source user is retained', (await db.user.findUnique({ where: { id: site.id } })).verseCoins === 777
      && (await db.user.findUnique({ where: { id: sourceId } })).verseCoins === SIGNUP_VC_GRANT
      && (await db.transaction.count({ where: { userId: site.id, type: 'signup_bonus' } })) === 0);
    check('sessions of the replaced Telegram profile stay revoked', !(await accounts.isTelegramSessionActive(before.id, sourceId)));
    const reused = await webhook(startUpdate(TG_UNUSED, `/start link_confirm_${confirmation}`));
    check('the confirmation is single use', /недействительна/.test(reused.body.text));
    const viaApp = await auth({ initData: launch(TG_UNUSED) });
    const sessionCookie = viaApp.cookies.find((c) => c.startsWith('nv-tg.session-token='));
    check('the next genuine launch signs in to the website account', viaApp.body.status === 'ok'
      && (await decode({ token: sessionCookie.split(';')[0].split('=').slice(1).join('='), secret: process.env.NEXTAUTH_SECRET })).sub === site.id);

    const blockedToken = (await linkCall('POST', (await db.user.create({ data: { email: 'unrelated@example.test', password: 'hash' } })).id)).body.url.split('link_')[1];
    const blocked = await webhook(startUpdate(TG_UNUSED, `/start link_${blockedToken}`));
    check('a Telegram identity linked to an existing website account cannot be taken over', /другим аккаунтом/.test(blocked.body.text)
      && (await db.telegramAccount.findUnique({ where: { telegramId: TG_UNUSED } })).userId === site.id);

    async function pendingTransfer(id) {
      await auth({ initData: launch(id), consent: true });
      const account = await db.telegramAccount.findUnique({ where: { telegramId: id } });
      const target = await db.user.create({ data: { email: `transfer-${id}@example.test`, password: 'hash' } });
      const token = (await linkCall('POST', target.id)).body.url.split('link_')[1];
      const prompt = await webhook(startUpdate(id, `/start link_${token}`));
      return { account, target, confirmation: prompt.body.reply_markup?.inline_keyboard[0][0].url?.split('start=link_confirm_')[1] };
    }
    const raced = await pendingTransfer('6661002');
    const ownCharacter = await db.character.create({ data: { userId: raced.account.userId, name: 'Сохранить персонажа' } });
    const protectedReply = await webhook(startUpdate('6661002', `/start link_confirm_${raced.confirmation}`));
    check('data created after the prompt blocks transfer and remains accessible to the original profile', /данные/.test(protectedReply.body.text)
      && (await db.telegramAccount.findUnique({ where: { telegramId: '6661002' } })).userId === raced.account.userId
      && (await db.character.findUnique({ where: { id: ownCharacter.id } })).userId === raced.account.userId);
    const expired = await pendingTransfer('6661003');
    await db.telegramLinkToken.updateMany({ where: { userId: expired.target.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expiredReply = await webhook(startUpdate('6661003', `/start link_confirm_${expired.confirmation}`));
    check('an expired confirmation cannot move an account', /недействительна/.test(expiredReply.body.text)
      && (await db.telegramAccount.findUnique({ where: { telegramId: '6661003' } })).userId === expired.account.userId);
    const replaced = await pendingTransfer('6661004');
    await linkCall('POST', replaced.target.id);
    const replacedReply = await webhook(startUpdate('6661004', `/start link_confirm_${replaced.confirmation}`));
    check('creating a new website link revokes an older confirmation', /недействительна/.test(replacedReply.body.text)
      && (await db.telegramAccount.findUnique({ where: { telegramId: '6661004' } })).userId === replaced.account.userId);
    const changedBalance = await pendingTransfer('6661005');
    await db.user.update({ where: { id: changedBalance.account.userId }, data: { verseCoins: { increment: 1 }, permanentCoins: { increment: 1 } } });
    const balanceReply = await webhook(startUpdate('6661005', `/start link_confirm_${changedBalance.confirmation}`));
    check('a balance change after the prompt blocks transfer', /изменения баланса/.test(balanceReply.body.text)
      && (await db.telegramAccount.findUnique({ where: { telegramId: '6661005' } })).userId === changedBalance.account.userId);
    const otherLogin = await pendingTransfer('6661006');
    await db.user.update({ where: { id: otherLogin.account.userId }, data: { email: 'telegram-now-has-email@example.test', password: 'hash' } });
    const otherLoginReply = await webhook(startUpdate('6661006', `/start link_confirm_${otherLogin.confirmation}`));
    check('adding a website login to the Telegram profile makes it ineligible for replacement', /данные/.test(otherLoginReply.body.text)
      && (await db.telegramAccount.findUnique({ where: { telegramId: '6661006' } })).userId === otherLogin.account.userId);
    const targetTaken = await pendingTransfer('6661007');
    await db.telegramAccount.create({ data: { telegramId: '6661998', userId: targetTaken.target.id, origin: 'site' } });
    const targetTakenReply = await webhook(startUpdate('6661007', `/start link_confirm_${targetTaken.confirmation}`));
    check('a destination linked to another Telegram after the prompt cannot be overwritten', /другой Telegram/.test(targetTakenReply.body.text)
      && (await db.telegramAccount.findUnique({ where: { telegramId: '6661007' } })).userId === targetTaken.account.userId);
    const concurrent = await pendingTransfer('6661008');
    const competingReplies = await Promise.all([
      webhook(startUpdate('6661008', `/start link_confirm_${concurrent.confirmation}`)),
      webhook(startUpdate('6661008', `/start link_confirm_${concurrent.confirmation}`)),
    ]);
    check('concurrent confirmations transfer once and keep both user records', competingReplies.filter((r) => /Telegram привязан/.test(r.body.text)).length === 1
      && (await db.telegramAccount.findUnique({ where: { telegramId: '6661008' } })).userId === concurrent.target.id
      && Boolean(await db.user.findUnique({ where: { id: concurrent.account.userId } })));
  }

  // Referral registration belongs to the first account creation, never to a later sign-in.
  {
    const referrer = await db.user.create({ data: { referralCode: 'TGREF1', realCoins: 0 } });
    const other = await db.user.create({ data: { referralCode: 'TGREF2', realCoins: 0 } });
    const initData = launch('5550201', { startParam: 'ref_TGREF1' });
    await auth({ initData });
    check('referral consent does not pay a bonus before registration', (await db.user.findUnique({ where: { id: referrer.id } })).realCoins === 0);
    await auth({ initData, consent: true, referralCode: 'TGREF2' });
    const user = await db.user.findFirst({ where: { telegramAccount: { telegramId: '5550201' } } });
    check('signed startapp referral creates the correct relationship and pays the existing referral reward without email', user?.referredBy === referrer.id
      && (await db.user.findUnique({ where: { id: referrer.id } })).realCoins === 100
      && (await db.user.findUnique({ where: { id: other.id } })).realCoins === 0);
    await auth({ initData: launch('5550201', { startParam: 'ref_TGREF2' }) });
    check('later launches neither change the referrer nor pay a second reward', (await db.user.findUnique({ where: { id: user.id } })).referredBy === referrer.id
      && await db.transaction.count({ where: { userId: referrer.id, type: 'referral' } }) === 1);
    await auth({ initData: launch('5550202'), consent: true, referralCode: 'tgref1' });
    check('legacy register links and bot buttons can pass a normalized referral code',
      (await db.user.findFirst({ where: { telegramAccount: { telegramId: '5550202' } } })).referredBy === referrer.id);
    await auth({ initData: launch('5550203', { startParam: 'ref_MISSING' }), consent: true });
    check('unknown referral codes do not prevent account creation', (await db.user.findFirst({ where: { telegramAccount: { telegramId: '5550203' } } })).referredBy === null);
    const stats = src('app/api/referral/stats/route.ts');
    session.userId = referrer.id;
    telegramRequest.context = true;
    const telegramStats = await (await stats.GET()).json();
    telegramRequest.context = false;
    const siteStats = await (await stats.GET()).json();
    session.userId = null;
    check('referral page receives a Telegram link only in Telegram, while the site keeps its existing link', telegramStats.telegramReferralUrl === 'https://t.me/nv_synthetic_bot?startapp=ref_TGREF1'
      && !siteStats.telegramReferralUrl && telegramStats.count === 2);
  }

  // ---------------------------------------------------------------------------------------------
  // 8. Telegram catalog filter; 5. neutral balance error; 9. chat, stories, continuation, guest
  // ---------------------------------------------------------------------------------------------
  {
    await h.helpers.model();
    const owner = await db.user.create({ data: { email: 'author@example.test', verseCoins: 1000 } });
    const viewer = await db.user.findUnique({ where: { id: newUserId } });
    const mk = (name, slug, extra = {}) => db.character.create({ data: { name, slug, userId: owner.id, isPublic: true, systemPrompt: `Ты — ${name}.`, greeting: 'Привет.', ...extra } });
    const listed = await mk('Лео Вампир', 'leo-vampire');
    const hidden = await mk('Скрытая Лилит', 'hidden-lilith');
    const privateOther = await mk('Приватная Лилит', 'private-lilith', { isPublic: false, imageUrl: 'data:image/png;base64,dGVzdA==' });
    const ownPrivate = await mk('Мой приватный Лео', 'my-private-leo', { isPublic: false, userId: viewer.id });
    const own = await db.character.create({ data: { name: 'Мой Лео', slug: 'my-leo', userId: viewer.id, isPublic: true, systemPrompt: 'Ты — мой персонаж.' } });
    await db.telegramCatalogEntry.create({ data: { characterId: listed.id } });
    // A legacy catalog entry must never make a now-private character public.
    await db.telegramCatalogEntry.create({ data: { characterId: privateOther.id } });
    const catalog = src('lib/publicCatalog.ts');
    const charactersRoute = src('app/api/characters/route.ts');
    const characterPublic = src('lib/characterPublic.ts');
    const chatRoute = src('app/api/chat/[id]/route.ts');
    const chatsRoute = src('app/api/chats/route.ts');
    const favoritesRoute = src('app/api/favorites/route.ts');
    const names = (rows) => rows.map((row) => row.name).sort().join(',');

    session.userId = viewer.id;
    telegramRequest.context = false;
    const siteCatalog = await catalog.getPublicCatalog('new', 1, '');
    telegramRequest.context = true;
    const tgCatalog = await catalog.getPublicCatalog('new', 1, '');
    const tgSearch = await catalog.getPublicCatalog('new', 1, 'Лилит');
    const tgForYou = await catalog.getPublicCatalog('for-you', 1, '');
    check('8.2 website catalog is unchanged (all public characters)', ['Лео Вампир', 'Скрытая Лилит', 'Мой Лео'].every((name) => names(siteCatalog.data).includes(name)));
    check('8.3 Telegram and website have the same public catalog', names(tgCatalog.data) === names(siteCatalog.data), names(tgCatalog.data));
    check('8.4 Telegram search and recommendations include public characters without a legacy entry', tgSearch.data.some(row => row.id === hidden.id)
      && tgForYou.data.some(row => row.id === hidden.id) && !tgForYou.data.some(row => row.id === privateOther.id));
    const api = await (await charactersRoute.GET(new NextRequest(`${SITE}/api/characters?limit=50`))).json();
    const apiSearch = await (await charactersRoute.GET(new NextRequest(`${SITE}/api/characters?search=${encodeURIComponent('Лилит')}`))).json();
    check('8.5 characters API includes all public cards, excludes others private cards', (api.data ?? api.characters ?? []).some(row => row.id === hidden.id)
      && !(api.data ?? api.characters ?? []).some(row => row.id === privateOther.id)
      && (apiSearch.data ?? apiSearch.characters ?? []).some(row => row.id === hidden.id));
    check('8.6 direct links to public characters without a legacy entry open in Telegram',
      (await characterPublic.findCharacterBySlugForViewer('hidden-lilith', viewer.id))?.id === hidden.id
      && (await characterPublic.findCharacterBySlugForViewer('leo-vampire', viewer.id))?.id === listed.id
      && (await characterPublic.findCharacterBySlugForViewer('my-leo', viewer.id))?.id === own.id);
    const hiddenChat = await chatRoute.GET(new NextRequest(`${SITE}/api/chat/${hidden.id}`), { params: Promise.resolve({ id: hidden.id }) });
    check('8.7 chat with a public character without a legacy entry opens in Telegram', hiddenChat.status === 200);
    check('private cards remain author-only even with a legacy Telegram entry',
      (await characterPublic.findCharacterBySlugForViewer(privateOther.slug, viewer.id)) === null
      && (await characterPublic.findCharacterBySlugForViewer(ownPrivate.slug, viewer.id))?.id === ownPrivate.id
      && [403, 404].includes((await chatRoute.GET(new NextRequest(`${SITE}/api/chat/${privateOther.id}`), { params: Promise.resolve({ id: privateOther.id }) })).status));
    const avatarRoute = src('app/api/characters/[id]/avatar/route.ts');
    const avatar = (id) => avatarRoute.GET(new NextRequest(`${SITE}/api/characters/${id}/avatar`), { params: Promise.resolve({ id }) });
    for (const id of [hidden.id, listed.id, own.id]) await db.character.update({ where: { id }, data: { imageUrl: 'data:image/png;base64,dGVzdA==' } });
    const hiddenAvatar = await avatar(hidden.id);
    const listedAvatar = await avatar(listed.id);
    check('Telegram avatar API allows all public images and hides others private images', hiddenAvatar.status === 200
      && (await avatar(privateOther.id)).status === 404
      && listedAvatar.status === 200 && (await avatar(own.id)).status === 200 && listedAvatar.headers.get('cache-control') === 'private, no-store');
    const picks = await src('lib/onboardingPicks.ts').getOnboardingPicks({ style: null, gender: null, interests: [], page: 0 });
    check('onboarding includes the full public catalog and excludes private cards', picks.characters.some((card) => card.id === listed.id)
      && picks.characters.some((card) => card.id === hidden.id) && picks.characters.every((card) => card.id !== privateOther.id));
    const asset = 'a'.repeat(32);
    await db.character.update({ where: { id: privateOther.id }, data: { imageUrl: `/api/character-media/${owner.id}/${asset}` } });
    const mediaRoute = src('app/api/character-media/[owner]/[asset]/route.ts');
    const hiddenMedia = await mediaRoute.GET(new NextRequest(`${SITE}/api/character-media/${owner.id}/${asset}`), { params: Promise.resolve({ owner: owner.id, asset }) });
    check('stable media URLs hide others private images before accessing storage', hiddenMedia.status === 404);
    await db.character.update({ where: { id: hidden.id }, data: { imageUrl: 'data:image/png;base64,dGVzdA==' } });
    telegramRequest.context = false;
    const siteAvatar = await avatar(hidden.id);
    check('website avatars still load and their cache varies by Cookie', siteAvatar.status === 200 && siteAvatar.headers.get('vary') === 'Cookie');
    check('8.8 the same character opens on the website', (await characterPublic.findCharacterBySlugForViewer('hidden-lilith', viewer.id))?.id === hidden.id
      && (await chatRoute.GET(new NextRequest(`${SITE}/api/chat/${hidden.id}`), { params: Promise.resolve({ id: hidden.id }) })).status === 200);

    // Public website histories carry across; private histories remain inaccessible.
    await h.helpers.messages(viewer.id, hidden.id, [{ role: 'user', content: 'Привет с сайта' }, { role: 'assistant', content: 'Привет!' }], { mirror: false });
    await db.favorite.createMany({ data: [{ userId: viewer.id, characterId: hidden.id }, { userId: viewer.id, characterId: listed.id }] });
    await h.helpers.messages(viewer.id, privateOther.id, [{ role: 'user', content: 'Old history' }], { mirror: false });
    await db.favorite.create({ data: { userId: viewer.id, characterId: privateOther.id } });

    telegramRequest.context = true;
    const chat = await h.chat(viewer.id, listed.id, { message: 'Привет, Лео!' });
    check('9.1 chat with an approved character works in Telegram (fake AI)', chat.status === 200 && chat.events.some((event) => event.type === 'end'));
    const threadsRoute = src('app/api/chat/[id]/threads/route.ts');
    session.userId = viewer.id;
    const createdThread = await threadsRoute.POST(new NextRequest(`${SITE}/api/chat/${listed.id}/threads`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }), { params: Promise.resolve({ id: listed.id }) });
    const thread = (await createdThread.json()).thread;
    const second = await h.chat(viewer.id, listed.id, { message: 'Новая история.' }, 'ru', thread.id);
    const threadMessages = await db.message.count({ where: { threadId: thread.id } });
    check('9.2 independent stories work in Telegram (a new story gets its own messages)', createdThread.status === 201 && second.status === 200 && threadMessages >= 2 && threadMessages === await db.message.count({ where: { threadId: thread.id, characterId: listed.id } }) && (await db.message.count({ where: { threadId: thread.id, content: 'Привет, Лео!' } })) === 0, { status: createdThread.status, chat: second.status, threadMessages });
    const continued = await h.chat(viewer.id, listed.id, { continue: true }, 'ru', thread.id);
    check('9.3 continuing a reply works in Telegram', continued.status === 200 && continued.events.some((event) => event.type === 'end'));
    session.userId = viewer.id;
    const chats = await (await chatsRoute.GET()).json();
    const favorites = await (await favoritesRoute.GET()).json();
    check('8.9 Telegram chats and favorites include all public cards and exclude others private cards',
      chats.data.some((row) => row.character.id === hidden.id) && chats.data.some((row) => row.character.id === listed.id)
      && chats.data.every((row) => row.character.id !== privateOther.id)
      && favorites.data.some((row) => row.id === hidden.id) && favorites.data.some((row) => row.id === listed.id)
      && favorites.data.every((row) => row.id !== privateOther.id));

    const broke = await db.user.create({ data: { email: 'broke@example.test', verseCoins: 0 } });
    session.userId = broke.id;
    const poorRequest = () => chatRoute.POST(new NextRequest(`${SITE}/api/chat/${listed.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Привет' }) }), { params: Promise.resolve({ id: listed.id }) });
    const poor = await poorRequest();
    const poorBody = await poor.json();
    check('5.4 missing VC in Telegram: neutral "Баланс VC исчерпан" without price or link', poor.status === 402 && poorBody.error === 'Баланс VC исчерпан'
      && !/купи|пополн|\/coins|₽|руб/i.test(JSON.stringify(poorBody)), poorBody);
    telegramRequest.context = false;
    const sitePoor = await (await poorRequest()).json();
    check('5.5 the website keeps its own balance message', sitePoor.error === 'Недостаточно VerseCoins');

    // Guest chat in the Telegram context (no session): approved character works, hidden is 404.
    session.userId = null;
    telegramRequest.context = true;
    const guestCookie = `anonymousSessionId=${randomBytes(16).toString('hex')}`;
    const guest = async (characterId) => chatRoute.POST(new NextRequest(`${SITE}/api/chat/${characterId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: guestCookie },
      body: JSON.stringify({ message: 'Привет', requestId: `req${randomBytes(6).toString('hex')}` }) }), { params: Promise.resolve({ id: characterId }) });
    const guestHidden = await guest(hidden.id);
    const guestListed = await guest(listed.id);
    const guestPrivate = await guest(privateOther.id);
    const guestText = await guestListed.text();
    check('9.4 Telegram guest chat allows all public characters and rejects private ones', guestHidden.status === 200 && guestPrivate.status === 401
      && guestListed.status === 200 && /"type":"end"|assistant/.test(guestText), { hidden: guestHidden.status, listed: guestListed.status, private: guestPrivate.status });

    await db.character.update({ where: { id: hidden.id }, data: { isPublic: false } });
    check('unpublishing a card revokes Telegram catalog, direct-link and avatar access immediately',
      !(await catalog.getPublicCatalog('new', 1, '')).data.some(row => row.id === hidden.id)
      && await characterPublic.findCharacterBySlugForViewer(hidden.slug, viewer.id) === null
      && (await avatar(hidden.id)).status === 404);
    await db.character.update({ where: { id: hidden.id }, data: { isPublic: true } });
    check('publishing a card makes it available without a Telegram selection',
      (await catalog.getPublicCatalog('new', 1, '')).data.some(row => row.id === hidden.id)
      && (await characterPublic.findCharacterBySlugForViewer(hidden.slug, null))?.id === hidden.id);

    // Daily bonus: a Telegram account counts as a verified identity (no email in the Mini App).
    const bonusRoute = src('app/api/daily-bonus/route.ts');
    session.userId = viewer.id;
    const bonus = await bonusRoute.POST(new NextRequest(`${SITE}/api/daily-bonus`, { method: 'POST' }));
    const noEmailSite = await db.user.create({ data: { verseCoins: 0 } });
    session.userId = noEmailSite.id;
    const siteBonus = await bonusRoute.POST(new NextRequest(`${SITE}/api/daily-bonus`, { method: 'POST' }));
    check('5.6 daily bonus works for a Telegram account without email; others still need a confirmed email',
      bonus.status === 200 && siteBonus.status === 403, { telegram: bonus.status, site: siteBonus.status });
    telegramRequest.context = false;
    session.userId = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Migration SQL: repeatable and identical to the Prisma schema
  // ---------------------------------------------------------------------------------------------
  {
    const { readFileSync } = await import('node:fs');
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: h.databaseUrl.replace(/\/nv_memory_test$/, '/postgres') });
    await admin.connect();
    await admin.query('CREATE DATABASE nv_telegram_migration');
    await admin.end();
    const ddl = new pg.Client({ connectionString: h.databaseUrl.replace(/\/nv_memory_test$/, '/nv_telegram_migration') });
    await ddl.connect();
    const sql = (name) => readFileSync(join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8')
      .replace('CREATE EXTENSION IF NOT EXISTS vector;', '-- pgvector omitted in this disposable fixture')
      .replace(/vector\(\d+\)/g, 'BYTEA')
      .replace(/CREATE INDEX "MessageEmbeddingDeepinfra_embedding_hnsw_idx"[\s\S]*?;/g, '-- pgvector index omitted');
    const { readdirSync } = await import('node:fs');
    const names = readdirSync(join(root, 'prisma/migrations')).filter((name) => /^\d+_/.test(name)).sort();
    check('Telegram migration is present in the chain', names.includes('20261014180000_telegram_miniapp'), names);
    for (const name of names) await ddl.query(sql(name));
    const telegramSql = readFileSync(join(root, 'prisma/migrations/20261014180000_telegram_miniapp/migration.sql'), 'utf8');
    check('migration has no semicolons in comments (Adminer splits by ";")', telegramSql.split('\n').filter((line) => line.trim().startsWith('--')).every((line) => !line.includes(';')));
    // Adminer order: statement by statement, twice.
    for (const statement of telegramSql.split(';').map((part) => part.trim()).filter((part) => part && !/^(--[^\n]*\n?)*$/.test(part))) await ddl.query(statement);
    check('migration is repeatable (second run, statement by statement like Adminer)', true);
    const tables = (await ddl.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'Telegram%' ORDER BY 1`)).rows.map((row) => row.table_name);
    check('migration creates the four Telegram tables', tables.join(',') === 'TelegramAccount,TelegramCatalogEntry,TelegramInitDataReceipt,TelegramLinkToken', tables);
    const columnsBefore = (await ddl.query(`SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name IN ('User','Character')`)).rows[0].c;
    const { spawnSync } = await import('node:child_process');
    const migratedUrl = h.databaseUrl.replace(/\/nv_memory_test$/, '/nv_telegram_migration');
    const telegramDrift = () => {
      const diff = spawnSync(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-url', migratedUrl,
        '--to-schema-datamodel', join(root, 'prisma/schema.prisma'), '--script'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: migratedUrl } });
      if (diff.status !== 0) throw new Error(`prisma migrate diff failed: ${(diff.stderr || '').slice(0, 300)}`);
      return diff.stdout.split('\n').filter((line) => /Telegram/.test(line));
    };
    const drift = telegramDrift();
    check('migrated database matches schema.prisma for the Telegram tables', drift.length === 0, drift);
    // Negative control: the comparison does notice a missing Telegram index.
    await ddl.query('DROP INDEX "TelegramLinkToken_userId_createdAt_idx"');
    check('schema comparison detects Telegram drift (control)', telegramDrift().some((line) => line.includes('TelegramLinkToken_userId_createdAt_idx')));
    await ddl.end();
    check('existing tables are not altered by the migration (only new tables, FKs on them)', columnsBefore > 0
      && !/ALTER TABLE "(?!Telegram)/.test(telegramSql) && !/DROP TABLE|DROP COLUMN|ALTER COLUMN/i.test(telegramSql));
  }

  // Deployment before configuration/migration must leave ordinary website requests working.
  delete process.env.TELEGRAM_MINIAPP_ENABLED;
  telegramRequest.context = false;
  const emailVerification = src('lib/emailVerification.ts');
  const refused = await emailVerification.rejectUnverifiedEmail(new NextRequest(`${SITE}/api/daily-bonus`), newUserId,
    'api.confirmEmailToClaimBonus', { allowTelegramIdentity: true });
  check('without the feature flag Telegram identity does not change the website bonus rules', refused?.status === 403);
  await db.$executeRawUnsafe('DROP TABLE "TelegramAccount", "TelegramCatalogEntry", "TelegramInitDataReceipt", "TelegramLinkToken"');
  const catalogWithoutMigration = await src('lib/publicCatalog.ts').getPublicCatalog('new', 1, '');
  const picksWithoutMigration = await src('lib/onboardingPicks.ts').getOnboardingPicks({ style: null, gender: null, interests: [], page: 0 });
  check('without Telegram tables or variables the website catalog and onboarding still work', catalogWithoutMigration.data.length > 0 && picksWithoutMigration.characters.length > 0);
  const unavailableAuth = await auth({ initData: launch('5550901'), consent: true });
  const unavailableWebhook = await webhook(startUpdate('5550901', '/start'));
  const unavailableLink = await linkCall('GET', newUserId);
  check('without configuration or migration all Telegram entry APIs are disabled safely', unavailableAuth.status === 404 && unavailableWebhook.status === 404 && unavailableLink.status === 404);

  console.log(`\nverify:telegram — ${passed} passed`);
} finally {
  await h.stop();
}
