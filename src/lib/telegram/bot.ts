import { localizedValue, translate } from "../getDictionary";
import { LOCALES, negotiateLocale, type Locale } from "../i18nConfig";
import { consumeLinkToken, confirmTelegramLink, confirmTelegramMerge, LINK_START_PREFIX, LINK_CONFIRM_PREFIX, MERGE_CONFIRM_PREFIX, type LinkResult } from "./accounts";
import { telegramBotUsername, telegramSiteOrigin } from "./config";
import { parseTelegramStartParam, telegramReferralFromStartParam, TELEGRAM_ENTRY_PATH } from "./shared";
import { approveWebLogin, prepareWebLogin, webLoginCode, WEB_LOGIN_START, WEB_LOGIN_CONFIRM } from "./webLogin";

// Bot commands. Replies are returned in the webhook response body (Bot API "reply to webhook"),
// so the server makes no outbound call and needs the token only to verify Mini App launches.
// Message texts are not stored or logged; only the command name is.

type Lang = Locale;
type InlineButton = { text: string; web_app?: { url: string }; url?: string };
export type BotReply = {
  method: "sendMessage";
  chat_id: number | string;
  text: string;
  reply_markup?: { inline_keyboard: InlineButton[][] };
  link_preview_options?: { is_disabled: boolean };
};

const TEXT = Object.fromEntries(LOCALES.map(code => [code, localizedValue<Record<string, string>>(code, "telegramBot")])) as Record<Lang, Record<string, string>>;

function lang(code: unknown): Lang {
  return negotiateLocale(typeof code === "string" ? code : null);
}

function miniAppUrl(campaign: string | null, referral: string | null): string {
  const url = new URL(TELEGRAM_ENTRY_PATH, telegramSiteOrigin());
  // Label only; the Mini App turns it into utm_campaign before analytics start.
  if (campaign) url.searchParams.set("tgsrc", campaign);
  if (referral) url.searchParams.set("ref", referral);
  return url.toString();
}

function openButton(l: Lang, campaign: string | null = null, referral: string | null = null): InlineButton[] {
  return [{ text: TEXT[l].open, web_app: { url: miniAppUrl(campaign, referral) } }];
}

function reply(chatId: number | string, text: string, keyboard?: InlineButton[][]): BotReply {
  return {
    method: "sendMessage",
    chat_id: chatId,
    text,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    link_preview_options: { is_disabled: true },
  };
}

type Update = {
  message?: {
    text?: unknown;
    chat?: { id?: unknown; type?: unknown };
    from?: { id?: unknown; is_bot?: unknown; language_code?: unknown };
  };
};

export type BotOutcome = { command: string; reply: BotReply | null; link?: LinkResult };

/** Handles one update. Only private chats with a human sender get an answer. */
export async function handleBotUpdate(update: unknown): Promise<BotOutcome> {
  const message = (update as Update | null)?.message;
  const chatId = message?.chat?.id;
  const fromId = message?.from?.id;
  if (!message || message.chat?.type !== "private" || message.from?.is_bot === true
    || (typeof chatId !== "number" && typeof chatId !== "string")
    || (typeof fromId !== "number" && typeof fromId !== "string")) {
    return { command: "ignored", reply: null };
  }
  const l = lang(message.from?.language_code);
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const [rawCommand, payload = ""] = text.split(/\s+/, 2);
  const command = rawCommand.replace(/@[A-Za-z0-9_]+$/, "").toLowerCase();
  const origin = telegramSiteOrigin();

  if (command === "/start") {
    if (payload.startsWith(MERGE_CONFIRM_PREFIX)) {
      const result = await confirmTelegramMerge(payload.slice(MERGE_CONFIRM_PREFIX.length), String(fromId));
      return { command: "start_merge_confirm", link: result, reply: reply(chatId, TEXT[l][result], result === "merged" ? [openButton(l)] : undefined) };
    }
    if (payload.startsWith(WEB_LOGIN_CONFIRM)) {
      const approved = await approveWebLogin(payload.slice(WEB_LOGIN_CONFIRM.length), String(fromId));
      return { command: "website_login_confirm", reply: reply(chatId, translate(l, approved ? "telegramBot.signInApproved" : "telegramBot.signInInvalid")) };
    }
    if (payload.startsWith(WEB_LOGIN_START)) {
      const key = payload.slice(WEB_LOGIN_START.length);
      const state = await prepareWebLogin(key, String(fromId));
      const bot = telegramBotUsername();
      const text = state === "confirm" && bot
        ? translate(l, "telegramBot.signIn01", { value1: webLoginCode(key) })
        : state === "no_account"
          ? translate(l, "telegramBot.signIn02")
          : translate(l, "telegramBot.signIn03");
      return { command: "website_login", reply: reply(chatId, text, state === "confirm" && bot
        ? [[{ text: translate(l, "telegramBot.signIn04"), url: `https://t.me/${bot}?start=${WEB_LOGIN_CONFIRM}${key}` }]] : [openButton(l)]) };
    }
    if (payload.startsWith(LINK_CONFIRM_PREFIX)) {
      const result = await confirmTelegramLink(payload.slice(LINK_CONFIRM_PREFIX.length), String(fromId));
      return { command: "start_link_confirm", link: result, reply: reply(chatId, TEXT[l][result], result === "linked" ? [openButton(l)] : undefined) };
    }
    if (payload.startsWith(LINK_START_PREFIX)) {
      const decision = await consumeLinkToken(payload.slice(LINK_START_PREFIX.length), String(fromId));
      const result = decision.result;
      if (result === "merge_confirmation_required" && decision.confirmationToken && decision.mergeSummary) {
        const bot = telegramBotUsername();
        if (!bot) return { command: "start_link", link: "invalid", reply: reply(chatId, TEXT[l].invalid) };
        const values = { account: decision.siteLabel ?? "NewVerse", ...decision.mergeSummary };
        const text = TEXT[l].merge_confirmation_required.replace(/\{\{(account|characters|stories|messages|vc)\}\}/g, (_, key: keyof typeof values) => String(values[key]));
        return { command: "start_link", link: result, reply: reply(chatId, text,
          [[{ text: TEXT[l].confirmMerge, url: `https://t.me/${bot}?start=${MERGE_CONFIRM_PREFIX}${decision.confirmationToken}` }]]) };
      }
      if (result === "confirmation_required" && decision.confirmationToken) {
        const bot = telegramBotUsername();
        if (!bot) return { command: "start_link", link: "invalid", reply: reply(chatId, TEXT[l].invalid) };
        // Only the status reaches webhook diagnostics; the one-time confirmation token is never logged.
        return { command: "start_link", link: result, reply: reply(chatId,
          TEXT[l].confirmation_required.replace("{{account}}", decision.siteLabel ?? "NewVerse"),
          [[{ text: TEXT[l].confirmLink, url: `https://t.me/${bot}?start=${LINK_CONFIRM_PREFIX}${decision.confirmationToken}` }]]) };
      }
      const keyboard = result === "linked" || result === "already_linked" ? [openButton(l)] : undefined;
      return { command: "start_link", link: result, reply: reply(chatId, TEXT[l][result], keyboard) };
    }
    const { campaign } = parseTelegramStartParam(payload);
    return { command: "start", reply: reply(chatId, TEXT[l].welcome, [openButton(l, campaign, telegramReferralFromStartParam(payload))]) };
  }
  if (command === "/help") {
    return { command: "help", reply: reply(chatId, TEXT[l].help, [
      [{ text: TEXT[l].rules, url: `${origin}/${l}/rules` }, { text: TEXT[l].support, url: `${origin}/${l}/support` }],
      openButton(l),
    ]) };
  }
  if (command === "/privacy") {
    return { command: "privacy", reply: reply(chatId, TEXT[l].privacy, [[{ text: TEXT[l].privacyButton, url: `${origin}/${l}/privacy` }]]) };
  }
  return { command: "other", reply: reply(chatId, TEXT[l].unknown, [openButton(l)]) };
}
