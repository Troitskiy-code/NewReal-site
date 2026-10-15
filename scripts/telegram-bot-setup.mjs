// Bot setup for the owner: webhook with secret, commands, menu button opening the Mini App.
// Run by the owner on their machine with their own environment; values are never printed.
//   node --env-file=.env scripts/telegram-bot-setup.mjs --site https://newvers.ai          # plan only
//   node --env-file=.env scripts/telegram-bot-setup.mjs --site https://newvers.ai --apply  # perform
//   node --env-file=.env scripts/telegram-bot-setup.mjs --info                             # read-only status
// Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in the environment (names only in this repo).
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
const hide = (text) => String(text).split(token || '\u0000').join('<TELEGRAM_BOT_TOKEN>').split(secret || '\u0000').join('<TELEGRAM_WEBHOOK_SECRET>');

if (!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token)) {
  console.error('TELEGRAM_BOT_TOKEN is missing or malformed in the environment.');
  process.exit(1);
}

async function call(method, payload) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}),
    });
    const data = await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }));
    return data;
  } catch (error) {
    return { ok: false, description: hide(error instanceof Error ? error.message : error) };
  }
}

if (flag('--info')) {
  const me = await call('getMe');
  const info = await call('getWebhookInfo');
  const menu = await call('getChatMenuButton');
  console.log(hide(JSON.stringify({
    bot: me.ok ? { username: me.result.username, can_join_groups: me.result.can_join_groups } : me.description,
    webhook: info.ok ? { url: info.result.url, pending_update_count: info.result.pending_update_count,
      last_error_message: info.result.last_error_message ?? null, allowed_updates: info.result.allowed_updates ?? null } : info.description,
    menuButton: menu.ok ? menu.result : menu.description,
  }, null, 2)));
  process.exit(0);
}

const site = option('--site');
let origin;
try {
  origin = new URL(site ?? '').origin;
  if (!origin.startsWith('https://')) throw new Error('https only');
} catch {
  console.error('Pass --site https://<domain> (Telegram requires HTTPS for webhooks and Mini Apps).');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{24,256}$/.test(secret)) {
  console.error('TELEGRAM_WEBHOOK_SECRET is missing or shorter than 24 characters (allowed: A-Z a-z 0-9 _ -).');
  process.exit(1);
}

const commands = {
  ru: [
    { command: 'start', description: 'Открыть NewVerse' },
    { command: 'help', description: 'Помощь и правила' },
    { command: 'privacy', description: 'Политика конфиденциальности' },
  ],
  en: [
    { command: 'start', description: 'Open NewVerse' },
    { command: 'help', description: 'Help and rules' },
    { command: 'privacy', description: 'Privacy policy' },
  ],
};
const steps = [
  ['setWebhook', { url: `${origin}/api/telegram/webhook`, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true, max_connections: 20 }],
  ['setMyCommands', { commands: commands.en }],
  ['setMyCommands', { commands: commands.ru, language_code: 'ru' }],
  ['setChatMenuButton', { menu_button: { type: 'web_app', text: 'NewVerse', web_app: { url: `${origin}/tg` } } }],
];

for (const [method, payload] of steps) {
  const shown = hide(JSON.stringify(payload));
  if (!flag('--apply')) { console.log(`plan: ${method} ${shown}`); continue; }
  const result = await call(method, payload);
  console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${method}${result.ok ? '' : `: ${hide(result.description ?? 'unknown error')}`}`);
  if (!result.ok) process.exitCode = 1;
}
if (!flag('--apply')) console.log('\nNothing was changed. Add --apply to perform these calls.');
