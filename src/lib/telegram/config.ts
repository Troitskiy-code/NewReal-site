import { DEFAULT_INIT_DATA_MAX_AGE_SECONDS } from "./initData";

// Environment of the Telegram Mini App. Values are never logged: only names appear in code and docs.
//   TELEGRAM_MINIAPP_ENABLED          "1" turns the Mini App, bot webhook and Telegram sign-in on
//   TELEGRAM_BOT_TOKEN                bot token from @BotFather (initData signature key)
//   TELEGRAM_WEBHOOK_SECRET           secret_token passed to setWebhook (header check)
//   TELEGRAM_BOT_USERNAME             bot username without "@", for t.me links
//   TELEGRAM_INITDATA_MAX_AGE_SECONDS optional, default 3600

export function isTelegramMiniAppEnabled(): boolean {
  return ["1", "true"].includes(String(process.env.TELEGRAM_MINIAPP_ENABLED ?? "").trim().toLowerCase());
}

export function telegramBotToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token && /^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token) ? token : null;
}

export function telegramWebhookSecret(): string | null {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  // Telegram allows 1-256 characters A-Z, a-z, 0-9, _ and -. Short secrets are refused.
  return secret && /^[A-Za-z0-9_-]{24,256}$/.test(secret) ? secret : null;
}

export function telegramBotUsername(): string | null {
  const name = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return name && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) ? name : null;
}

export function telegramInitDataMaxAgeSeconds(): number {
  const value = Number(process.env.TELEGRAM_INITDATA_MAX_AGE_SECONDS);
  return Number.isInteger(value) && value >= 60 && value <= 86400 ? value : DEFAULT_INIT_DATA_MAX_AGE_SECONDS;
}

/** Public origin for links in bot messages (Mini App button, rules, privacy). */
export function telegramSiteOrigin(): string {
  for (const raw of [process.env.NEXTAUTH_URL, process.env.NEXT_PUBLIC_APP_URL]) {
    try {
      const url = new URL(String(raw ?? ""));
      if (url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1") return url.origin;
    } catch { /* next candidate */ }
  }
  return "https://newvers.ai";
}
