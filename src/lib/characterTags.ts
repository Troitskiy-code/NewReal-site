export const CHARACTER_TAG_GROUPS = [
  {
    id: "gender",
    label: "Гендерные",
    tags: ["Мужчина", "Девушка", "Томбой", "Антропоморфный", "Пушистый"],
  },
  {
    id: "roles",
    label: "Роли",
    tags: [
      "Оригинальный персонаж",
      "Сосед",
      "Друг",
      "Партнёр",
      "Герой",
      "Злодей",
      "Враг",
      "Офис",
    ],
  },
  {
    id: "traits",
    label: "Черты характера",
    tags: [
      "Милый/Добрый",
      "Цундере",
      "Сложный",
      "Флиртующий",
      "От лица мужчины",
      "От лица женщины",
      "Брак",
    ],
  },
  {
    id: "genres",
    label: "Жанры и сеттинги",
    tags: [
      "Фэнтези",
      "Драма",
      "Аниме",
      "Реалистичный",
      "RPG",
      "Экшен",
      "Приключение",
      "Комедия",
      "Ужасы",
      "Sci-Fi",
      "Мистика",
      "Готика",
      "Сверхъестественное",
      "Симулятор",
      "Романтика",
      "Магия",
      "Постапокалипсис",
      "Исторический",
      "VR",
      "Триллер",
      "Пародия",
    ],
  },
  {
    id: "bot",
    label: "Характеристики бота",
    tags: [
      "Из медиа",
      "Из игры",
      "Монстр",
      "Мускулистый",
      "Гигантский",
      "Несколько персонажей",
      "Игра",
      "Сценарий",
      "Пухлый",
      "Эльф",
      "Андроид",
    ],
  },
] as const;

export const ALL_CHARACTER_TAGS: string[] = CHARACTER_TAG_GROUPS.flatMap((g) => [...g.tags]);

/** Old spellings still stored on existing characters; mapped so normalizing does not drop them. */
const LEGACY_TAG_ALIASES: Record<string, string> = { "Цуцере": "Цундере" };

/** Genres shown as catalog chips and card badges; `id` keys the translation in home.genres. */
export const FEATURED_GENRES = [
  { id: "fantasy", tag: "Фэнтези" },
  { id: "romance", tag: "Романтика" },
  { id: "anime", tag: "Аниме" },
  { id: "scifi", tag: "Sci-Fi" },
  { id: "mystic", tag: "Мистика" },
  { id: "realistic", tag: "Реалистичный" },
  { id: "adventure", tag: "Приключение" },
  { id: "horror", tag: "Ужасы" },
  { id: "comedy", tag: "Комедия" },
  { id: "drama", tag: "Драма" },
] as const;

export type FeaturedGenre = (typeof FEATURED_GENRES)[number];

export function parseTagsString(tags: string | null | undefined): string[] {
  if (!tags) return [];
  return tags
    .split(",")
    .map((t) => t.trim())
    .map((t) => LEGACY_TAG_ALIASES[t] ?? t)
    .filter(Boolean);
}

export function pickFeaturedGenre(tags: string | null | undefined): FeaturedGenre | null {
  for (const tag of parseTagsString(tags)) {
    const genre = FEATURED_GENRES.find((item) => item.tag === tag);
    if (genre) return genre;
  }
  return null;
}

export function joinTagsString(tags: string[]): string {
  return tags.join(", ");
}

export function normalizeTagsString(tags: string | null | undefined): string | null {
  const parsed = parseTagsString(tags);
  const valid = parsed.filter((t) => ALL_CHARACTER_TAGS.includes(t));
  return valid.length > 0 ? joinTagsString(valid) : null;
}

export function toggleTagInString(current: string, tag: string): string {
  const selected = new Set(parseTagsString(current));
  if (selected.has(tag)) {
    selected.delete(tag);
  } else {
    selected.add(tag);
  }
  return joinTagsString(Array.from(selected));
}

export function removeTagFromString(current: string, tag: string): string {
  return joinTagsString(parseTagsString(current).filter((t) => t !== tag));
}
