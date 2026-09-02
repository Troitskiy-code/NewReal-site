import type { Metadata } from "next";

export const SITE_URL = "https://newvers.ai";
export const OG_IMAGE = "/logo.png";

export function createPageMetadata(title: string, description: string): Metadata {
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: OG_IMAGE }],
    },
  };
}

export const PAGE_METADATA = {
  home: createPageMetadata(
    "NewVerse — Твоя вселенная персонажей для ролевых игр с ИИ",
    "Общайтесь с уникальными ИИ-персонажами в ролевых играх. Создавайте свои миры и истории."
  ),
  gallery: createPageMetadata(
    "Галерея персонажей NewVerse",
    "Выберите персонажа для ролевой игры. Десятки уникальных героев с разными характерами и сюжетами."
  ),
  create: createPageMetadata(
    "Создать персонажа — NewVerse",
    "Создайте своего уникального ИИ-персонажа для ролевых игр."
  ),
  edit: createPageMetadata(
    "Редактировать персонажа — NewVerse",
    "Настройте внешность, характер и сценарий вашего персонажа."
  ),
  profile: createPageMetadata(
    "Мой профиль — NewVerse",
    "Управляйте подпиской, личностями и настройками аккаунта."
  ),
  pricing: createPageMetadata(
    "Тарифы NewVerse — подписки для ролевых игр с ИИ",
    "Выберите тариф для доступа к расширенному контексту, бонусным VC и генерации аватаров."
  ),
  coins: createPageMetadata(
    "Пополнить баланс VC — NewVerse",
    "Купите VerseCoins для общения с ИИ-персонажами."
  ),
  referral: createPageMetadata(
    "Реферальная программа — NewVerse",
    "Приглашайте друзей и получайте бонусы."
  ),
  subscription: createPageMetadata(
    "Управление подпиской — NewVerse",
    "Просмотр и отключение автопродления подписки."
  ),
  offer: createPageMetadata(
    "Публичная оферта — NewVerse",
    "Условия использования сервиса NewVerse."
  ),
  refund: createPageMetadata(
    "Политика возврата — NewVerse",
    "Условия возврата средств в NewVerse."
  ),
  terms: createPageMetadata(
    "Пользовательское соглашение — NewVerse",
    "Правила использования платформы NewVerse."
  ),
  support: createPageMetadata(
    "Поддержка — NewVerse",
    "Свяжитесь с нами для решения вопросов."
  ),
} as const;

export function chatPageMetadata(characterName: string): Metadata {
  return createPageMetadata(
    `Чат с персонажем ${characterName} — NewVerse`,
    `Ролевая игра с персонажем ${characterName}. Погрузитесь в историю и развивайте сюжет.`
  );
}
