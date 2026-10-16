import { consumeLinkToken, confirmTelegramLink, confirmTelegramMerge, LINK_START_PREFIX, LINK_CONFIRM_PREFIX, MERGE_CONFIRM_PREFIX, type LinkResult } from "./accounts";
import { telegramBotUsername, telegramSiteOrigin } from "./config";
import { parseTelegramStartParam, telegramReferralFromStartParam, TELEGRAM_ENTRY_PATH } from "./shared";
import { approveWebLogin, prepareWebLogin, webLoginCode, WEB_LOGIN_START, WEB_LOGIN_CONFIRM } from "./webLogin";

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
    merge_confirmation_required: "Объединить профиль Telegram с аккаунтом сайта {{account}}? Будут перенесены персонажи: {{characters}}, истории: {{stories}}, сообщения: {{messages}} и заработанные VC: {{vc}}. Повторные стартовые 50 VC не начисляются. Истории и персонажи сайта сохранятся. Старые Telegram-сессии завершатся. Подтверждайте только для своего аккаунта.",
    confirmMerge: "Перенести данные и объединить аккаунты",
    merge_busy: "Закройте Mini App, дождитесь завершения генераций и подождите 3 минуты. Затем создайте новую ссылку в профиле сайта. Перенос начнётся только после отдельного подтверждения.",
    merged: "Данные перенесены, аккаунты объединены. Закройте и заново откройте Mini App: в нём будут истории, персонажи и баланс общего аккаунта.",
    profile_not_empty: "Привязка остановлена: в профиле есть новые данные или изменения баланса, отдельный способ входа, покупки, подписка либо конфликт реферальных настроек. Создайте новую ссылку в профиле сайта. Если перенос снова недоступен, обратитесь в поддержку — данные сохранятся.",
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
    merge_confirmation_required: "Merge your Telegram profile into website account {{account}}? Characters: {{characters}}, stories: {{stories}}, messages: {{messages}}, earned VC: {{vc}} will be transferred. The duplicate starter 50 VC are excluded. Existing website stories and characters are kept. Old Telegram sessions will end. Confirm only for your own account.",
    confirmMerge: "Transfer data and merge accounts",
    merge_busy: "Close the Mini App, let all generations finish, and wait 3 minutes. Then create a new link in your website profile. A separate confirmation is required before any data moves.",
    merged: "Your data has been transferred and accounts merged. Close and reopen the Mini App to see the shared stories, characters and balance.",
    profile_not_empty: "Linking was stopped because the profile has changed, has independent sign-in credentials, purchases, a subscription, or conflicting referral settings. Create a fresh website link. If transfer is still unavailable, contact support; your data is kept.",
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
    if (payload.startsWith(MERGE_CONFIRM_PREFIX)) {
      const result = await confirmTelegramMerge(payload.slice(MERGE_CONFIRM_PREFIX.length), String(fromId));
      return { command: "start_merge_confirm", link: result, reply: reply(chatId, TEXT[l][result], result === "merged" ? [openButton(l)] : undefined) };
    }
    if (payload.startsWith(WEB_LOGIN_CONFIRM)) {
      const approved = await approveWebLogin(payload.slice(WEB_LOGIN_CONFIRM.length), String(fromId));
      return { command: "website_login_confirm", reply: reply(chatId, l === "ru"
        ? approved ? "Вход подтверждён. Вернитесь в тот браузер, где начали вход, и нажмите «Войти в этот аккаунт»." : "Запрос недействителен или истёк. Начните вход заново на сайте."
        : approved ? "Approved. Return to the browser where you started and choose “Sign in to this account”." : "This request is invalid or expired. Start again on the website.") };
    }
    if (payload.startsWith(WEB_LOGIN_START)) {
      const key = payload.slice(WEB_LOGIN_START.length);
      const state = await prepareWebLogin(key, String(fromId));
      const bot = telegramBotUsername();
      const text = state === "confirm" && bot
        ? l === "ru"
          ? `Вход на сайт NewVerse. Код запроса: ${webLoginCode(key)}.\n\nСверьте код с браузером. Подтверждайте только если вы сами начали вход на newvers.ai. Этот браузер получит доступ к вашим историям, персонажам и балансу. Никому не пересылайте эту ссылку.`
          : `NewVerse website sign-in. Request code: ${webLoginCode(key)}.\n\nMatch this code with your browser. Approve only if you started signing in on newvers.ai. That browser will access your stories, characters and balance. Do not forward this link.`
        : state === "no_account"
          ? l === "ru" ? "Сначала откройте Mini App и создайте аккаунт или привяжите существующий в профиле сайта." : "First create an account in the Mini App or link your existing website account."
          : l === "ru" ? "Запрос недействителен или истёк. Начните вход заново на сайте." : "This request is invalid or expired. Start again on the website.";
      return { command: "website_login", reply: reply(chatId, text, state === "confirm" && bot
        ? [[{ text: l === "ru" ? "Подтвердить вход на сайт" : "Approve website sign-in", url: `https://t.me/${bot}?start=${WEB_LOGIN_CONFIRM}${key}` }]] : [openButton(l)]) };
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
