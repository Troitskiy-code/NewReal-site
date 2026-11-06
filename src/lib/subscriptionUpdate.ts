import type { Locale } from "./i18nConfig";

export const SUBSCRIPTION_UPDATE_PATH = "/news/subscription-update";
export const SUBSCRIPTION_UPDATE_PREVIEW = "subscription-update";
const ANNOUNCEMENT_DATE = "2026-11-06";
const PLANNED_LAUNCH_DATE = "2026-11-21";

// A snapshot of the announced offer. It can be published before checkout prices change.
export const ANNOUNCED_SUBSCRIPTIONS = [
  { id: "dialog", oldMonthly: 499, monthly: 399, yearly: 3990, vc: 600, context: 6000 },
  { id: "story", oldMonthly: 1299, monthly: 899, yearly: 8990, vc: 2000, context: 10000 },
  { id: "universe", oldMonthly: 3499, monthly: 1790, yearly: 17900, vc: 6000, context: 16000 },
] as const;

export function subscriptionUpdateState(now = new Date()) {
  const date = new Date(`${PLANNED_LAUNCH_DATE}T00:00:00+03:00`);
  const announced = now >= new Date(`${ANNOUNCEMENT_DATE}T00:00:00+03:00`);
  return {
    date: announced ? date : null,
    dateTime: announced ? PLANNED_LAUNCH_DATE : null,
    showBanner: announced && now < date,
    isPreview: process.env.NODE_ENV === "development",
  };
}

const ru = {
  lang: "ru",
  eyebrow: "Новости NewVerse",
  preview: "Дату запуска объявим отдельно",
  starts: "Планируемая дата запуска",
  bannerTitle: "Больше общения. Подписки от 399 ₽",
  bannerText: "Снижаем цены, включаем чат на двух моделях без расхода VC и обновляем оплату озвучки и аватаров.",
  bannerLink: "Что изменится",
  back: "В каталог",
  title: "Больше общения за меньшую цену",
  intro: "Снижаем цены на все подписки NewVerse. На двух моделях можно будет переписываться с любимыми персонажами, продолжать сцены и пробовать другие варианты ответов без расхода VC.",
  modelLabel: "В каждой подписке",
  modelText: "Gemma 4 Turbo и DeepSeek V4 Flash",
  priceLabel: "Новая цена «Диалога»",
  priceText: "399 ₽ в месяц",
  pricingHeading: "Новые цены и пакеты VC",
  pricingText: "Выбирайте по размаху истории. Объём контекста и пакет VC растут вместе с уровнем подписки. Ежемесячные пакеты VC станут меньше, поскольку переписка на двух включённых моделях больше не будет их расходовать.",
  plans: {
    dialog: { name: "Диалог", description: "Для бесед с любимыми персонажами и коротких сцен." },
    story: { name: "История", description: "Для длинных сцен, неожиданных поворотов и сюжетов с продолжением." },
    universe: { name: "Вселенная", description: "Для больших миров, постоянных героев и нескольких сюжетных линий." },
  },
  previous: "Было",
  month: "в месяц",
  year: "за год",
  vc: "VC ежемесячно",
  context: "токенов контекста",
  sections: [
    {
      title: "Что изменится для действующих подписчиков",
      text: "Доступ к двум моделям без расхода VC появится в день обновления. Если на дату запуска у вас действует оплаченная подписка, безлимитная озвучка сохранится до конца этого периода. Пока действует переходная квота аватаров, сначала расходуются включённые генерации.",
      detail: "Автопродления после запуска идут по новой цене. Платёж, выставленный заранее по прежней цене, сохраняет прежний пакет VC. Если автопродление попадает в переходный период, начисляется прежний пакет. Действующим подписчикам «Истории», которые сохраняют тариф, на первое автопродление после переходного периода начислим 10 000 VC.",
    },
    {
      title: "Сколько стоят озвучка и аватары",
      text: "Обычная озвучка доступна всем за 3 VC/с. Подписчики могут выбрать обычную или выразительную за 5 VC/с. Ежедневную бесплатную озвучку отменяем. Длительность готовой записи округляется вверх до целой секунды. Оплаченную запись можно переслушивать без доплаты, пока она хранится в чате.",
      detail: "Платная генерация аватара или обложки стоит 50 VC за результат. Цена одинаковая для генерации с референсом и без него.",
    },
    {
      title: "Что будет с балансом VC",
      text: "Купленные VC сохраняются без срока действия. По новым месячным и годовым тарифам пакет VC обновляется каждый месяц. Неиспользованный остаток подписочного пакета не переносится.",
      detail: "VC можно тратить на ответы премиум-моделей. Только для пользователей без подписки ответы на базовой модели после исчерпания бесплатной дневной квоты оплачиваются в VC. Сначала расходуются монеты с ограниченным сроком действия.",
    },
    {
      title: "Как работает чат без списания VC",
      text: "На две включённые модели действует общий лимит в 120 ответов в час. После 1 000 ответов за сутки в «Диалоге», 1 500 в «Истории» или 2 000 во «Вселенной» чат продолжится с контекстом «Диалога» до полуночи по Москве. Эти меры помогают защитить сервис от массовых запросов через скрипты и совместного использования одного аккаунта несколькими людьми.",
      detail: "Без подписки сохраняется бесплатная дневная квота на базовой модели. После неё можно продолжить общение за VC.",
    },
  ],
  supportTitle: "Вопрос о подписке или балансе?",
  supportLink: "Написать в поддержку",
};

const en: typeof ru = {
  lang: "en",
  eyebrow: "NewVerse news",
  preview: "Launch date to be announced",
  starts: "Planned launch date",
  bannerTitle: "More time to chat. Plans from ₽399",
  bannerText: "Lower prices, two included chat models, and new rates for voice playback and avatars.",
  bannerLink: "See what’s changing",
  back: "Back to characters",
  title: "More time to chat for less",
  intro: "We’re lowering the price of every NewVerse subscription. On two included models, you’ll be able to chat with your favorite characters, continue scenes, and try alternate replies without spending VC.",
  modelLabel: "Included in every plan",
  modelText: "Gemma 4 Turbo and DeepSeek V4 Flash",
  priceLabel: "New Dialog price",
  priceText: "₽399 per month",
  pricingHeading: "New prices and VC allowances",
  pricingText: "Pick a plan that fits your story. Higher tiers give you more context and more VC each month. Monthly VC allowances will be smaller because chatting on the two included models will no longer use them.",
  plans: {
    dialog: { name: "Dialog", description: "For conversations with favorite characters and quick scenes." },
    story: { name: "Story", description: "For long scenes, plot twists, and ongoing stories." },
    universe: { name: "Universe", description: "For expansive worlds, recurring characters, and multiple storylines." },
  },
  previous: "Previously",
  month: "per month",
  year: "per year",
  vc: "VC every month",
  context: "context tokens",
  sections: [
    {
      title: "What changes for current subscribers",
      text: "You can chat on both included models without spending VC starting on launch day. If you have an active paid subscription at launch, unlimited voice playback stays included until the end of that paid period. Any avatar generations still included during the transition are used first.",
      detail: "Automatic renewals after launch use the new prices. If a payment was already issued at the old price, it keeps the old VC allowance. Automatic renewals during the transition also keep the old allowance. Existing Story subscribers who stay on the plan receive 10,000 VC at their first automatic renewal after the transition.",
    },
    {
      title: "Voice and avatar prices",
      text: "Standard voice is available to everyone for 3 VC/sec. Subscribers can also choose expressive voice for 5 VC/sec. The daily free playback is ending. We round the duration of the finished recording up to a whole second. You can replay a purchased recording at no extra cost while it’s stored in the chat.",
      detail: "Paid avatar and cover generation costs 50 VC per result, with or without a reference image.",
    },
    {
      title: "What happens to your VC balance",
      text: "Purchased VC have no expiry date. New monthly and annual plans refresh their VC allowance each month. Unused subscription VC do not roll over.",
      detail: "You can spend VC on replies from premium models. Only users without a subscription pay VC for replies on the base model after using their free daily allowance. Coins with an expiry date are used first.",
    },
    {
      title: "How chat without spending VC works",
      text: "The two included models share a limit of 120 replies per hour. After 1,000 replies in a day on Dialog, 1,500 on Story, or 2,000 on Universe, chat continues with Dialog context until midnight Moscow time. These measures help protect the service from automated requests at scale and from multiple people sharing one account.",
      detail: "Accounts without a subscription still get a free daily allowance on the base model. You can continue chatting with VC after using it.",
    },
  ],
  supportTitle: "Questions about your plan or VC balance?",
  supportLink: "Contact support",
};

export function subscriptionUpdateCopy(locale: Locale) {
  return locale === "ru" ? ru : en;
}

export function formatSubscriptionUpdateDate(date: Date, lang: string) {
  return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "Europe/Moscow" }).format(date);
}
