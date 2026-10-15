import { consumeLinkToken, confirmTelegramLink, LINK_START_PREFIX, LINK_CONFIRM_PREFIX, type LinkResult } from "./accounts";
import { telegramBotUsername, telegramSiteOrigin } from "./config";
import { parseTelegramStartParam, telegramReferralFromStartParam, TELEGRAM_ENTRY_PATH } from "./shared";

// Bot commands. Replies are returned in the webhook response body (Bot API "reply to webhook"),
// so the server makes no outbound call and needs the token only to verify Mini App launches.
// Message texts are not stored or logged; only the command name is.

type Lang = "ru" | "en";
type InlineButton = { text: string; web_app?: { url: string }; url?: string };
export type BotReply = {
  method: "sendMessage";
  chat_id: number | string;
  text: string;
  reply_markup?: { inline_keyboard: InlineButton[][] };
  link_preview_options?: { is_disabled: boolean };
};

const TEXT = {
  ru: {
    welcome: "NewVerse — ролевые истории с ИИ-персонажами. Откройте приложение, чтобы выбрать персонажа и начать историю.",
    open: "Открыть NewVerse",
    help: "Команды:\n/start — открыть NewVerse\n/help — помощь\n/privacy — политика конфиденциальности\n\nПравила сервиса и поддержка — по кнопкам ниже.",
    rules: "Правила",
    support: "Поддержка",
    privacy: "Политика конфиденциальности NewVerse:",
    privacyButton: "Открыть политику",
    linked: "Telegram привязан к вашему аккаунту NewVerse. Теперь в приложении тот же аккаунт и баланс VC, что и на сайте. Закройте и заново откройте Mini App по кнопке ниже.",
    already_linked: "Этот Telegram уже привязан к вашему аккаунту NewVerse.",
    invalid: "Ссылка для привязки недействительна: она одноразовая и действует 10 минут. Создайте новую в профиле на сайте.",
    telegram_taken: "Этот Telegram уже связан с другим аккаунтом NewVerse, например созданным в приложении. Аккаунты не объединяются автоматически. Чтобы привязать Telegram к аккаунту сайта, используйте другой Telegram или напишите в поддержку.",
    confirmation_required: "В Telegram у вас отдельный пустой профиль со стартовыми 50 VC. Подтвердите переход на аккаунт сайта: {{account}}. В приложении будут баланс, персонажи и истории этого аккаунта сайта. Стартовые 50 VC из пустого профиля не переносятся. Если это не ваш аккаунт, не подтверждайте привязку.",
    confirmLink: "Подтвердить привязку аккаунта сайта",
    profile_not_empty: "В профиле Telegram уже есть данные или изменения баланса. Автоматическая привязка остановлена, чтобы сохранить их. Для переноса обратитесь в поддержку NewVerse.",
    user_has_other_telegram: "К этому аккаунту NewVerse уже привязан другой Telegram. Сначала отвяжите его в профиле на сайте.",
    unknown: "Используйте /start, чтобы открыть NewVerse, или /help для справки.",
  },
  en: {
    welcome: "NewVerse is role-play stories with AI characters. Open the app to choose a character and start a story.",
    open: "Open NewVerse",
    help: "Commands:\n/start — open NewVerse\n/help — help\n/privacy — privacy policy\n\nService rules and support are behind the buttons below.",
    rules: "Rules",
    support: "Support",
    privacy: "NewVerse privacy policy:",
    privacyButton: "Open the policy",
    linked: "Telegram is now linked to your NewVerse account. The app uses the same account and VC balance as the website. Close and reopen the Mini App using the button below.",
    already_linked: "This Telegram is already linked to your NewVerse account.",
    invalid: "This link is not valid: it works once and for 10 minutes. Create a new one in your profile on the website.",
    telegram_taken: "This Telegram is already connected to another NewVerse account, for example one created in the app. Accounts are not merged automatically. Use another Telegram account or contact support.",
    confirmation_required: "You have a separate unused Telegram profile with 50 starter VC. Confirm switching to the website account: {{account}}. The app will use that website account's balance, characters and stories. The 50 starter VC from the unused profile will not be transferred. If this is not your account, do not confirm the link.",
    confirmLink: "Confirm linking the website account",
    profile_not_empty: "Your Telegram profile already has data or balance changes. Automatic linking has been stopped to preserve them. Contact NewVerse support to arrange a transfer.",
    user_has_other_telegram: "Another Telegram is already linked to this NewVerse account. Unlink it in your profile on the website first.",
    unknown: "Use /start to open NewVerse or /help for help.",
  },
} as const;

function lang(code: unknown): Lang {
  return typeof code === "string" && code.toLowerCase().startsWith("ru") ? "ru" : "en";
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
    if (payload.startsWith(LINK_CONFIRM_PREFIX)) {
      const result = await confirmTelegramLink(payload.slice(LINK_CONFIRM_PREFIX.length), String(fromId));
      return { command: "start_link_confirm", link: result, reply: reply(chatId, TEXT[l][result], result === "linked" ? [openButton(l)] : undefined) };
    }
    if (payload.startsWith(LINK_START_PREFIX)) {
      const decision = await consumeLinkToken(payload.slice(LINK_START_PREFIX.length), String(fromId));
      const result = decision.result;
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
