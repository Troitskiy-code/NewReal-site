/** Canonical values remain Russian in storage; labels can be localized independently. */
export const CHARACTER_TAG_GROUPS = [
  { id: "genres", label: "Жанр", labelEn: "Genre", tags: ["Романтика", "Приключение", "Фэнтези", "Научная фантастика", "Детектив", "Драма", "Комедия", "Ужасы", "Триллер", "Мистика", "Повседневность", "Экшен"] },
  { id: "world", label: "Мир и время", labelEn: "World and setting", tags: ["Современный мир", "Исторический", "Средневековье", "Постапокалипсис", "Киберпанк", "Космос", "Магическая академия", "Готика"] },
  { id: "character", label: "Персонаж", labelEn: "Character", tags: ["Мужской персонаж", "Женский персонаж", "Антропоморфный", "Эльф", "Андроид", "Монстр"] },
  { id: "roles", label: "Роль и отношения", labelEn: "Role and relationships", tags: ["Друг", "Партнёр", "Сосед", "Напарник", "Наставник", "Соперник", "Герой", "Злодей", "Враг"] },
  { id: "traits", label: "Характер", labelEn: "Personality", tags: ["Добрый", "Заботливый", "Сдержанный", "Дерзкий", "Загадочный", "Холодный", "Ироничный", "Флиртующий", "Цундере"] },
  { id: "style", label: "Стиль истории", labelEn: "Story style", tags: ["Аниме", "Ролевая игра", "Медленное развитие отношений", "Выборы и последствия", "Исследование мира"] },
] as const;
export const ALL_CHARACTER_TAGS: string[] = CHARACTER_TAG_GROUPS.flatMap(group => [...group.tags]);
export const MAX_SELECTED_CHARACTER_TAGS = 8;
// Retained on old cards, removable in the editor, never offered or used as recommendation signals.
export const LEGACY_CHARACTER_TAGS = ["Томбой", "Пушистый", "Оригинальный персонаж", "Офис", "Сложный", "От лица мужчины", "От лица женщины", "Брак", "Магия", "Сверхъестественное", "VR", "Пародия", "Из медиа", "Из игры", "Мускулистый", "Гигантский", "Несколько персонажей", "Игра", "Сценарий", "Пухлый", "Симулятор"];
const TAG_ALIASES: Record<string, string> = {
  "Мужчина": "Мужской персонаж", "Девушка": "Женский персонаж", "Милый/Добрый": "Добрый",
  "Цуцере": "Цундере", "Sci-Fi": "Научная фантастика", "Реалистичный": "Современный мир", "RPG": "Ролевая игра",
  "Fantasy": "Фэнтези", "Romance": "Романтика", "Adventure": "Приключение", "Anime": "Аниме",
  "Detective": "Детектив", "Horror": "Ужасы", "Comedy": "Комедия", "Drama": "Драма",
  "Cyberpunk": "Киберпанк", "Slice of life": "Повседневность", "Science fiction": "Научная фантастика",
};
const canonicalByKey = new Map([...ALL_CHARACTER_TAGS, ...LEGACY_CHARACTER_TAGS].map(tag => [tag.toLocaleLowerCase("ru"), tag]));
const aliasesByKey = new Map(Object.entries(TAG_ALIASES).map(([key, value]) => [key.toLocaleLowerCase("ru"), value]));
export function canonicalCharacterTag(value: string): string | null {
  const key = value.trim().toLocaleLowerCase("ru");
  return aliasesByKey.get(key) ?? canonicalByKey.get(key) ?? null;
}
/** Search both old and new spellings, without rewriting production data. */
export function characterTagSearchTerms(value: string): string[] {
  const canonical = canonicalCharacterTag(value);
  if (!canonical) return [value.trim()];
  return [...new Set([canonical, ...Object.keys(TAG_ALIASES).filter(alias => TAG_ALIASES[alias] === canonical)])];
}
export const FEATURED_GENRES = [
  { id: "fantasy", tag: "Фэнтези" }, { id: "romance", tag: "Романтика" }, { id: "anime", tag: "Аниме" },
  { id: "scifi", tag: "Научная фантастика" }, { id: "mystic", tag: "Мистика" }, { id: "realistic", tag: "Современный мир" },
  { id: "adventure", tag: "Приключение" }, { id: "detective", tag: "Детектив" }, { id: "everyday", tag: "Повседневность" },
  { id: "cyberpunk", tag: "Киберпанк" }, { id: "horror", tag: "Ужасы" }, { id: "comedy", tag: "Комедия" }, { id: "drama", tag: "Драма" },
] as const;
export type FeaturedGenre = (typeof FEATURED_GENRES)[number];
export function parseTagsString(tags: string | null | undefined): string[] {
  if (!tags) return [];
  return [...new Set(tags.split(",").map(tag => tag.trim()).filter(Boolean).map(tag => canonicalCharacterTag(tag) ?? tag))];
}
export function recommendationTags(tags: string | null | undefined): string[] {
  return parseTagsString(tags).filter(tag => ALL_CHARACTER_TAGS.includes(tag));
}
export function pickFeaturedGenre(tags: string | null | undefined): FeaturedGenre | null {
  for (const tag of parseTagsString(tags)) {
    const genre = FEATURED_GENRES.find(item => item.tag === tag);
    if (genre) return genre;
  }
  return null;
}
export function joinTagsString(tags: string[]): string { return [...new Set(tags)].join(", "); }
export function normalizeTagsString(tags: string | null | undefined): string | null {
  const valid = parseTagsString(tags).filter(tag => ALL_CHARACTER_TAGS.includes(tag) || LEGACY_CHARACTER_TAGS.includes(tag));
  return valid.length ? joinTagsString(valid) : null;
}
export function toggleTagInString(current: string, tag: string): string {
  const canonical = canonicalCharacterTag(tag);
  if (!canonical || !ALL_CHARACTER_TAGS.includes(canonical)) return current;
  const selected = new Set(parseTagsString(current));
  if (selected.has(canonical)) selected.delete(canonical);
  else if (selected.size < MAX_SELECTED_CHARACTER_TAGS) selected.add(canonical);
  return joinTagsString([...selected]);
}
export function removeTagFromString(current: string, tag: string): string {
  return joinTagsString(parseTagsString(current).filter(item => item !== tag));
}
const EN_TAG_LABELS: Record<string, string> = {
  "Романтика": "Romance", "Приключение": "Adventure", "Фэнтези": "Fantasy", "Научная фантастика": "Sci-Fi", "Детектив": "Detective", "Драма": "Drama", "Комедия": "Comedy", "Ужасы": "Horror", "Триллер": "Thriller", "Мистика": "Mystery", "Повседневность": "Slice of life", "Экшен": "Action",
  "Современный мир": "Modern world", "Исторический": "Historical", "Средневековье": "Middle Ages", "Постапокалипсис": "Post-apocalyptic", "Киберпанк": "Cyberpunk", "Космос": "Space", "Магическая академия": "Magic academy", "Готика": "Gothic",
  "Мужской персонаж": "Male character", "Женский персонаж": "Female character", "Антропоморфный": "Anthropomorphic", "Эльф": "Elf", "Андроид": "Android", "Монстр": "Monster",
  "Друг": "Friend", "Партнёр": "Partner", "Сосед": "Neighbor", "Напарник": "Companion", "Наставник": "Mentor", "Соперник": "Rival", "Герой": "Hero", "Злодей": "Villain", "Враг": "Enemy",
  "Добрый": "Kind", "Заботливый": "Caring", "Сдержанный": "Reserved", "Дерзкий": "Bold", "Загадочный": "Mysterious", "Холодный": "Cold", "Ироничный": "Witty", "Флиртующий": "Flirty", "Цундере": "Tsundere",
  "Аниме": "Anime", "Ролевая игра": "Roleplay", "Медленное развитие отношений": "Slow-burn relationships", "Выборы и последствия": "Choices and consequences", "Исследование мира": "World exploration",
};
export function characterTagLabel(tag: string, locale: string, translate?: (key: string, fallback: string) => string): string {
  const fallback = locale.startsWith("ru") ? tag : EN_TAG_LABELS[tag] ?? tag;
  return translate ? translate(`characterTags.labels.${tag}`, fallback) : fallback;
}
