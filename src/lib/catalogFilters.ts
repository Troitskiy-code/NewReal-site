/** Catalog filters: separate from the name search, shared by the URL, the API and the panel. No server imports. */
import { ADULT_CHARACTER_TAG, parseTagsString } from "./characterTags";
import { resolveArtStyle, type ArtStyle } from "./onboarding";
import { roleplayMode, type RoleplayMode } from "./roleplayConfig";

export type CatalogGender = "female" | "male";
export type CatalogFilters = {
  style: ArtStyle | null;
  gender: CatalogGender | null;
  format: RoleplayMode | null;
  genres: string[];
  worlds: string[];
  traits: string[];
};
export const EMPTY_CATALOG_FILTERS: CatalogFilters = { style: null, gender: null, format: null, genres: [], worlds: [], traits: [] };

export const CATALOG_STYLES: readonly ArtStyle[] = ["anime", "realistic"];
export const CATALOG_GENDERS: readonly CatalogGender[] = ["female", "male"];
export const CATALOG_FORMATS: readonly RoleplayMode[] = ["character", "group", "world"];
export const CATALOG_GENDER_TAGS: Record<CatalogGender, string> = { female: "Женский персонаж", male: "Мужской персонаж" };

/** URL ids of the multi-select groups, most used first. Values are canonical tags. */
export const CATALOG_GENRE_TAGS: Record<string, string> = {
  romance: "Романтика", everyday: "Повседневность", fantasy: "Фэнтези", adventure: "Приключение", drama: "Драма", mystic: "Мистика",
  comedy: "Комедия", scifi: "Научная фантастика", action: "Экшен", detective: "Детектив", horror: "Ужасы", thriller: "Триллер",
};
export const CATALOG_WORLD_TAGS: Record<string, string> = {
  modern: "Современный мир", medieval: "Средневековье", cyberpunk: "Киберпанк", historical: "Исторический",
  academy: "Магическая академия", space: "Космос", gothic: "Готика", postapoc: "Постапокалипсис",
};
export const CATALOG_TRAIT_TAGS: Record<string, string> = {
  kind: "Добрый", caring: "Заботливый", mysterious: "Загадочный", flirty: "Флиртующий", cold: "Холодный",
  bold: "Дерзкий", reserved: "Сдержанный", witty: "Ироничный", tsundere: "Цундере",
};
/** Genres on the phone's quick row and on top of the panel; the rest open behind "more". */
export const CATALOG_QUICK_GENRES = ["romance", "everyday", "fantasy", "adventure", "drama", "mystic", "comedy"] as const;

const MULTI = { genres: CATALOG_GENRE_TAGS, worlds: CATALOG_WORLD_TAGS, traits: CATALOG_TRAIT_TAGS } as const;
type MultiGroup = keyof typeof MULTI;
const PARAM: Record<MultiGroup, string> = { genres: "genre", worlds: "world", traits: "trait" };
export const CATALOG_FILTER_PARAMS = ["style", "gender", "format", "genre", "world", "trait"] as const;

type ReadParam = (key: string) => string | null | undefined;

const readList = (raw: string | null | undefined, ids: Record<string, string>) =>
  [...new Set((raw ?? "").split(",").map(item => item.trim()).filter(item => Object.hasOwn(ids, item)))];

export function parseCatalogFilters(read: ReadParam): CatalogFilters {
  const style = read("style"), gender = read("gender"), format = read("format");
  return {
    style: CATALOG_STYLES.includes(style as ArtStyle) ? style as ArtStyle : null,
    gender: CATALOG_GENDERS.includes(gender as CatalogGender) ? gender as CatalogGender : null,
    format: CATALOG_FORMATS.includes(format as RoleplayMode) ? format as RoleplayMode : null,
    genres: readList(read("genre"), CATALOG_GENRE_TAGS),
    worlds: readList(read("world"), CATALOG_WORLD_TAGS),
    traits: readList(read("trait"), CATALOG_TRAIT_TAGS),
  };
}

/** Writes the filters into URL parameters, removing the ones that are not set. */
export function applyCatalogFiltersToParams(params: URLSearchParams, filters: CatalogFilters): URLSearchParams {
  for (const key of CATALOG_FILTER_PARAMS) params.delete(key);
  if (filters.style) params.set("style", filters.style);
  if (filters.gender) params.set("gender", filters.gender);
  if (filters.format) params.set("format", filters.format);
  for (const group of Object.keys(MULTI) as MultiGroup[]) if (filters[group].length) params.set(PARAM[group], filters[group].join(","));
  return params;
}

export function catalogFiltersQuery(filters: CatalogFilters): string {
  return applyCatalogFiltersToParams(new URLSearchParams(), filters).toString();
}

export const catalogFilterCount = (filters: CatalogFilters) =>
  (filters.style ? 1 : 0) + (filters.gender ? 1 : 0) + (filters.format ? 1 : 0) + filters.genres.length + filters.worlds.length + filters.traits.length;

/** Every required canonical tag; a card must carry all of them. */
export function catalogFilterTags(filters: CatalogFilters): string[] {
  return [
    ...(filters.gender ? [CATALOG_GENDER_TAGS[filters.gender]] : []),
    ...filters.genres.map(id => CATALOG_GENRE_TAGS[id]),
    ...filters.worlds.map(id => CATALOG_WORLD_TAGS[id]),
    ...filters.traits.map(id => CATALOG_TRAIT_TAGS[id]),
  ];
}

export type CatalogFilterOption =
  | { group: "style"; id: ArtStyle }
  | { group: "gender"; id: CatalogGender }
  | { group: "format"; id: RoleplayMode }
  | { group: MultiGroup; id: string };

export function isCatalogOptionActive(filters: CatalogFilters, option: CatalogFilterOption): boolean {
  if (option.group === "genres" || option.group === "worlds" || option.group === "traits") return filters[option.group].includes(option.id);
  return filters[option.group] === option.id;
}

/** Single-choice groups switch; multi-choice groups add or remove the option. */
export function toggleCatalogOption(filters: CatalogFilters, option: CatalogFilterOption): CatalogFilters {
  const active = isCatalogOptionActive(filters, option);
  if (option.group === "genres" || option.group === "worlds" || option.group === "traits") {
    const group = option.group;
    return { ...filters, [group]: active ? filters[group].filter(id => id !== option.id) : [...filters[group], option.id] };
  }
  return { ...filters, [option.group]: active ? null : option.id };
}

export function selectedCatalogOptions(filters: CatalogFilters): CatalogFilterOption[] {
  return [
    ...(filters.style ? [{ group: "style", id: filters.style } as const] : []),
    ...(filters.gender ? [{ group: "gender", id: filters.gender } as const] : []),
    ...(filters.format ? [{ group: "format", id: filters.format } as const] : []),
    ...filters.genres.map(id => ({ group: "genres", id }) as const),
    ...filters.worlds.map(id => ({ group: "worlds", id }) as const),
    ...filters.traits.map(id => ({ group: "traits", id }) as const),
  ];
}

export type CatalogFacetCard = { tags: string | null; artStyle?: string | null; roleplayMode?: string | null };

export function catalogCardMatches(card: CatalogFacetCard, filters: CatalogFilters): boolean {
  if (filters.format && roleplayMode(card.roleplayMode) !== filters.format) return false;
  if (filters.style && resolveArtStyle(card.artStyle, card.tags) !== filters.style) return false;
  const own = new Set(parseTagsString(card.tags));
  return catalogFilterTags(filters).every(tag => own.has(tag));
}

const optionKey = (option: CatalogFilterOption) => `${option.group}:${option.id}`;

export type CatalogFacets = {
  total: number;
  /** "group:id" → cards the list would show with this option turned on. */
  options: Record<string, number>;
  /** Selected "group:id" → cards the list would show without this option. */
  without: Record<string, number>;
};

export function allCatalogOptions(): CatalogFilterOption[] {
  return [
    ...CATALOG_STYLES.map(id => ({ group: "style", id }) as const),
    ...CATALOG_GENDERS.map(id => ({ group: "gender", id }) as const),
    ...CATALOG_FORMATS.map(id => ({ group: "format", id }) as const),
    ...Object.keys(CATALOG_GENRE_TAGS).map(id => ({ group: "genres", id }) as const),
    ...Object.keys(CATALOG_WORLD_TAGS).map(id => ({ group: "worlds", id }) as const),
    ...Object.keys(CATALOG_TRAIT_TAGS).map(id => ({ group: "traits", id }) as const),
  ];
}

export function computeCatalogFacets(cards: readonly CatalogFacetCard[], filters: CatalogFilters): CatalogFacets {
  const count = (next: CatalogFilters) => cards.filter(card => catalogCardMatches(card, next)).length;
  const options: Record<string, number> = {};
  for (const option of allCatalogOptions()) {
    const active = isCatalogOptionActive(filters, option);
    options[optionKey(option)] = count(active ? filters : toggleCatalogOption(filters, option));
  }
  const without: Record<string, number> = {};
  for (const option of selectedCatalogOptions(filters)) without[optionKey(option)] = count(toggleCatalogOption(filters, option));
  return { total: count(filters), options, without };
}

export const catalogOptionKey = optionKey;
export const isAdultCatalogCard = (tags: string | null | undefined) => parseTagsString(tags).includes(ADULT_CHARACTER_TAG);
