// Real isolated PostgreSQL, synthetic Telegram updates; no .env or external services.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { startHarness } from './lib/memory-test-harness.mjs';
const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const { decode } = require('next-auth/jwt');
const h = await startHarness({ label: 'telegram-accounts' });
const { db, root, load, session } = h;
Object.assign(process.env, { TELEGRAM_MINIAPP_ENABLED: '1', TELEGRAM_BOT_USERNAME: 'nv_synthetic_bot', NEXTAUTH_URL: 'http://localhost:3000' });
const src = (p) => load(join(root, 'src', p));
const login = src('lib/telegram/webLogin.ts');
const route = src('app/api/telegram/login/route.ts');
const accounts = src('lib/telegram/accounts.ts');
const bot = src('lib/telegram/bot.ts');
let passed = 0;
const check = (name, value) => { if (!value) throw new Error(name); passed++; console.log(`PASS ${name}`); };
const update = (id, payload) => ({ message: { text: `/start ${payload}`, chat: { id, type: 'private' }, from: { id, language_code: 'ru' } } });
const request = (method, cookie, body, headers = {}) => new NextRequest('http://localhost:3000/api/telegram/login', {
  method, headers: { host: 'localhost:3000', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(cookie ? { cookie: `nv-tg-login=${cookie}` } : {}), ...headers },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const old = () => new Date(Date.now() - 10 * 60_000);
async function sourceProfile(id) {
  const user = await db.user.create({ data: { name: 'Telegram owner', verseCoins: 120, permanentCoins: 120, lastSeen: old() } });
  const account = await db.telegramAccount.create({ data: { userId: user.id, telegramId: id, origin: 'telegram' } });
  return { user, account };
}
async function siteProfile() { return db.user.create({ data: { name: 'Website owner', email: `owner-${crypto.randomUUID()}@example.test`, password: 'hash', verseCoins: 777, permanentCoins: 777 } }); }
async function mergePrompt(source, target) {
  const { token } = await accounts.createLinkToken(target.id);
  return accounts.consumeLinkToken(token, source.account.telegramId);
}
try {
  const tg = await sourceProfile('77881001');
  const active = await Promise.all(Array.from({ length: 8 }, () => accounts.isTelegramSessionActive(tg.account.id, tg.user.id)));
  check('parallel session checks do not log out a valid user when updating activity', active.every(Boolean));
  const created = await route.POST(request('POST', null, { action: 'create' }));
  const start = await created.json();
  const cookie = created.cookies.get('nv-tg-login').value;
  const key = new URL(start.url).searchParams.get('start').slice('login_'.length);
  check('website request sets an independent httpOnly browser proof and expires in five minutes', created.status === 200 && cookie.split('.').length === 2
    && /HttpOnly/i.test(created.headers.get('set-cookie')) && /SameSite=strict/i.test(created.headers.get('set-cookie')));
  check('request fits Telegram payload and code matches bot', new URL(start.url).searchParams.get('start').length <= 64 && start.code === login.webLoginCode(key));
  check('request stores hashes only', !(await db.verificationToken.findFirst({ where: { OR: [{ token: key }, { identifier: cookie }] } })));
  const prompt = await bot.handleBotUpdate(update('77881001', `login_${key}`));
  check('opening bot only asks for explicit sign-in approval with matching code', prompt.reply.text.includes(start.code) && (await login.getWebLogin(cookie)).status === 'pending');
  check('unknown Telegram user cannot create or approve an account', await login.prepareWebLogin(key, '77881999') === 'no_account' && !(await login.approveWebLogin(key, '77881999')));
  check('unapproved request cannot be exchanged', (await route.POST(request('POST', cookie, { action: 'complete' }))).status === 401);
  const approved = await bot.handleBotUpdate(update('77881001', `login_ok_${key}`));
  check('second bot action approves existing profile', /подтверждён/.test(approved.reply.text) && (await login.getWebLogin(cookie)).status === 'approved');
  check('a browser holding only the Telegram link cannot use approval', (await login.getWebLogin(`${key}.${'x'.repeat(32)}`)).status === 'expired'
    && !(await login.consumeWebLogin(`${key}.${'x'.repeat(32)}`)));
  check('cross-site polling and state changes are refused', (await route.GET(request('GET', cookie, null, { 'sec-fetch-site': 'cross-site' }))).status === 403
    && (await route.POST(request('POST', cookie, { action: 'complete' }, { 'sec-fetch-site': 'cross-site' }))).status === 403);
  session.userId = tg.user.id;
  check('website sign-in does not silently switch a signed-in browser', (await route.POST(request('POST', cookie, { action: 'complete' }))).status === 409);
  session.userId = null;
  const response = await route.POST(request('POST', cookie, { action: 'complete' }));
  const jwt = response.cookies.get('next-auth.session-token')?.value;
  const decoded = jwt && await decode({ token: jwt, secret: process.env.NEXTAUTH_SECRET });
  check('website receives normal NextAuth cookie for the same user and revocable Telegram identity', response.status === 200 && decoded?.sub === tg.user.id && decoded.telegramAccountId === tg.account.id);
  check('website sign-in sets no Mini App context or partitioned cookie', !response.headers.get('set-cookie').includes('nv-tg.ctx') && !response.headers.get('set-cookie').includes('Partitioned'));
  check('successful exchange cannot be replayed', !(await login.consumeWebLogin(cookie)));
  const parallel = await login.createWebLogin();
  await login.approveWebLogin(parallel.key, '77881001');
  const exchanges = await Promise.all([login.consumeWebLogin(parallel.cookie), login.consumeWebLogin(parallel.cookie)]);
  check('parallel exchanges succeed once', exchanges.filter(Boolean).length === 1);
  const relink = await login.createWebLogin();
  await login.approveWebLogin(relink.key, '77881001');
  await db.telegramAccount.update({ where: { id: tg.account.id }, data: { id: crypto.randomUUID() } });
  check('rotating identity invalidates pending website approvals', !(await login.consumeWebLogin(relink.cookie)));
  const cancel = await login.createWebLogin();
  await login.cancelWebLogin(`${cancel.key}.${'z'.repeat(32)}`);
  check('wrong browser cannot cancel a request', (await login.getWebLogin(cancel.cookie)).status === 'pending');
  await login.cancelWebLogin(cancel.cookie);
  check('cancel revokes request', (await login.getWebLogin(cancel.cookie)).status === 'expired');
  const expired = await login.createWebLogin();
  await db.verificationToken.updateMany({ where: { identifier: { startsWith: 'tg-web:' } }, data: { expires: old() } });
  check('expired requests cannot be approved or exchanged', !(await login.approveWebLogin(expired.key, '77881001')) && !(await login.consumeWebLogin(expired.cookie)));
  const noBenefitsBefore = await db.transaction.count();
  check('website login never creates users or signup grants', await db.user.count() === 1 && noBenefitsBefore === 0);

  // Rich profiles, overlapping favorite/persona selections, independent stories and retained memory.
  const source = await sourceProfile('77882001');
  const site = await siteProfile();
  const hero = await db.character.create({ data: { name: 'Shared hero', userId: site.id, isPublic: true } });
  const own = await db.character.create({ data: { name: 'Telegram private hero', userId: source.user.id } });
  const persona = await db.persona.create({ data: { userId: source.user.id, name: 'Telegram persona' } });
  const sitePersona = await db.persona.create({ data: { userId: site.id, name: 'Site persona' } });
  const sourceStory = await db.chatThread.create({ data: { userId: source.user.id, characterId: hero.id, number: 1, personaId: persona.id } });
  const siteStory = await db.chatThread.create({ data: { userId: site.id, characterId: hero.id, number: 1, personaId: sitePersona.id } });
  const msg = await db.message.create({ data: { userId: source.user.id, characterId: hero.id, threadId: sourceStory.id, role: 'assistant', content: 'Remember this', createdAt: old() } });
  await db.memory.create({ data: { userId: source.user.id, characterId: hero.id, threadId: sourceStory.id, summary: 'Keep memory' } });
  await db.favorite.createMany({ data: [{ userId: source.user.id, characterId: hero.id }, { userId: site.id, characterId: hero.id }] });
  await db.personaSelection.createMany({ data: [{ userId: source.user.id, characterId: hero.id, personaId: persona.id }, { userId: site.id, characterId: hero.id, personaId: sitePersona.id }] });
  await db.chatPromptState.create({ data: { characterId: hero.id, scopeKey: `thread:${sourceStory.id}` } });
  const promptMerge = await mergePrompt(source, site);
  check('populated profile asks for separate merge confirmation and earned VC preview', promptMerge.result === 'merge_confirmation_required' && promptMerge.mergeSummary.vc === 70
    && promptMerge.mergeSummary.characters === 1 && promptMerge.mergeSummary.messages === 1);
  check('no data moves before consent', (await db.message.findUnique({ where: { id: msg.id } })).userId === source.user.id);
  check('wrong Telegram cannot approve a populated-profile transfer', await accounts.confirmTelegramMerge(promptMerge.confirmationToken, '77882999') === 'invalid');
  const merged = await accounts.confirmTelegramMerge(promptMerge.confirmationToken, source.account.telegramId);
  check('explicit merge succeeds', merged === 'merged');
  check('same message ids/content and separate thread ids survive', (await db.message.findUnique({ where: { id: msg.id } })).userId === site.id
    && (await db.message.findUnique({ where: { id: msg.id } })).threadId === sourceStory.id && await db.chatThread.count({ where: { userId: site.id, characterId: hero.id } }) === 2);
  check('story numbers are distinct and existing story is unchanged', (await db.chatThread.findUnique({ where: { id: sourceStory.id } })).number === 2
    && (await db.chatThread.findUnique({ where: { id: siteStory.id } })).number === 1);
  check('private character, persona, memory and prompt settings survive transfer', (await db.character.findUnique({ where: { id: own.id } })).userId === site.id
    && (await db.persona.findUnique({ where: { id: persona.id } })).userId === site.id && await db.memory.count({ where: { userId: site.id, summary: 'Keep memory' } }) === 1
    && await db.chatPromptState.count({ where: { scopeKey: `thread:${sourceStory.id}` } }) === 1);
  check('duplicate favorites coalesce and destination persona choice is retained', await db.favorite.count({ where: { userId: site.id, characterId: hero.id } }) === 1
    && (await db.personaSelection.findUnique({ where: { userId_characterId: { userId: site.id, characterId: hero.id } } })).personaId === sitePersona.id);
  check('earned VC transfer without duplicate signup grant and source cannot spend twice', (await db.user.findUnique({ where: { id: site.id } })).verseCoins === 847
    && (await db.user.findUnique({ where: { id: source.user.id } })).verseCoins === 0);
  check('both user records and transfer audit trail remain', Boolean(await db.user.findUnique({ where: { id: source.user.id } }))
    && await db.transaction.count({ where: { type: { startsWith: 'telegram_merge_' } } }) === 2);
  check('old Telegram session is revoked immediately and replay cannot transfer twice', !(await accounts.isTelegramSessionActive(source.account.id, source.user.id))
    && await accounts.confirmTelegramMerge(promptMerge.confirmationToken, source.account.telegramId) === 'invalid');
  check('next Telegram launch resolves shared website account', (await accounts.resolveTelegramUser({ id: source.account.telegramId }, { consent: false })).userId === site.id);

  const changed = await sourceProfile('77882002');
  const destination = await siteProfile();
  const initial = await mergePrompt(changed, destination);
  await db.user.update({ where: { id: changed.user.id }, data: { verseCoins: 121, permanentCoins: 121 } });
  check('source balance changes invalidate old merge consent', await accounts.confirmTelegramMerge(initial.confirmationToken, changed.account.telegramId) === 'invalid');
  await db.user.update({ where: { id: changed.user.id }, data: { lastSeen: new Date() } });
  check('recent app activity blocks transfer while requests may still run', (await mergePrompt(changed, destination)).result === 'merge_busy');
  await db.user.update({ where: { id: changed.user.id }, data: { lastSeen: old(), subscriptionType: 'premium' } });
  check('paid/subscribed profiles never lose contracts through an automatic transfer', (await mergePrompt(changed, destination)).result === 'profile_not_empty');
  await db.user.update({ where: { id: changed.user.id }, data: { subscriptionType: 'start', email: 'independent@example.test', password: 'hash' } });
  check('independent website credentials cannot be taken over by a Telegram merge', (await mergePrompt(changed, destination)).result === 'profile_not_empty');

  const legacySource = await sourceProfile('77882003');
  const legacyTarget = await siteProfile();
  const legacyMessage = await db.message.create({ data: { userId: legacySource.user.id, characterId: hero.id, role: 'assistant', content: 'Legacy', createdAt: old() } });
  await db.chatPromptState.create({ data: { scopeKey: `user:${legacySource.user.id}`, characterId: hero.id } });
  const legacyPrompt = await mergePrompt(legacySource, legacyTarget);
  check('legacy data merge succeeds', await accounts.confirmTelegramMerge(legacyPrompt.confirmationToken, legacySource.account.telegramId) === 'merged');
  const movedLegacy = await db.message.findUnique({ where: { id: legacyMessage.id } });
  check('legacy messages and prompt state get their own story', Boolean(movedLegacy.threadId) && movedLegacy.userId === legacyTarget.id
    && await db.chatPromptState.count({ where: { scopeKey: `thread:${movedLegacy.threadId}` } }) === 1);
  const spent = await sourceProfile('77882004');
  const spentTarget = await siteProfile();
  await db.user.update({ where: { id: spent.user.id }, data: { verseCoins: 20, permanentCoins: 20 } });
  await db.transaction.createMany({ data: [
    { userId: spent.user.id, type: 'signup_bonus', amount: 50, description: 'Signup' },
    { userId: spent.user.id, type: 'daily_bonus', amount: 20, description: 'Earned' },
    { userId: spent.user.id, type: 'chat', amount: -50, description: 'Starter coins spent' },
  ] });
  const spentPrompt = await mergePrompt(spent, spentTarget);
  check('earned balance below 50 survives when starter VC have already been spent', spentPrompt.mergeSummary.vc === 20);
  const simultaneous = await Promise.all([
    accounts.confirmTelegramMerge(spentPrompt.confirmationToken, spent.account.telegramId),
    accounts.confirmTelegramMerge(spentPrompt.confirmationToken, spent.account.telegramId),
  ]);
  check('concurrent populated-profile confirmations transfer earned VC once', simultaneous.filter(r => r === 'merged').length === 1
    && (await db.user.findUnique({ where: { id: spentTarget.id } })).verseCoins === 797);
  const occupied = await sourceProfile('77882005');
  const occupiedTarget = await siteProfile();
  const occupiedPrompt = await mergePrompt(occupied, occupiedTarget);
  await db.telegramAccount.create({ data: { userId: occupiedTarget.id, telegramId: '77882998', origin: 'site' } });
  check('a destination occupied after preview is not overwritten', await accounts.confirmTelegramMerge(occupiedPrompt.confirmationToken, occupied.account.telegramId) === 'user_has_other_telegram'
    && (await db.telegramAccount.findUnique({ where: { id: occupied.account.id } })).userId === occupied.user.id);
  console.log(`Telegram account checks: ${passed} passed`);
} finally { await h.stop(); }
