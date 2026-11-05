import { ADULT_CHARACTER_TAG, ALL_CHARACTER_TAGS, canonicalCharacterTag, characterTagSearchTerms } from "./characterTags";
import { catalogFilterTags, type CatalogFilters } from "./catalogFilters";

/** Genre pages match the same tag spellings as a genre chip typed into the catalog search. */
export function catalogTagCondition(tag: string) {
  return { OR: characterTagSearchTerms(tag).map(term => ({ tags: { contains: term, mode: "insensitive" as const } })) };
}

/**
 * Shared by the initial server page and subsequent API pages. Tags match only a whole tag name:
 * a part of a name ("Рома") must not bring in every card tagged "Романтика".
 */
export function catalogSearchCondition(search: string) {
  const query = search.trim().slice(0, 200);
  if (!query) return {};
  const tag = canonicalCharacterTag(query);
  return { OR: [
    { name: { contains: query, mode: "insensitive" as const } },
    { name_en: { contains: query, mode: "insensitive" as const } },
    { translations: { some: { name: { contains: query, mode: "insensitive" as const } } } },
    ...(tag && ALL_CHARACTER_TAGS.includes(tag) ? catalogTagCondition(tag).OR : []),
  ] };
}

const REALISTIC_STYLE_TAG = "Реалистичный";

/** Same rules as catalogCardMatches: an explicit art style wins, old cards fall back to their tag. */
export function catalogFiltersConditions(filters: CatalogFilters) {
  const and: Record<string, unknown>[] = catalogFilterTags(filters).map(tag => catalogTagCondition(tag));
  if (filters.format) {
    and.push(filters.format === "character"
      ? { NOT: { roleplayMode: { in: ["world", "group"] } } }
      : { roleplayMode: filters.format });
  }
  if (filters.style) {
    const tag = filters.style === "anime" ? catalogTagCondition("Аниме") : { tags: { contains: REALISTIC_STYLE_TAG, mode: "insensitive" as const } };
    and.push({ OR: [{ artStyle: filters.style }, { AND: [{ artStyle: null }, tag] }] });
  }
  return and;
}

export const catalogAdultHiddenCondition = { OR: [{ tags: null }, { NOT: { tags: { contains: ADULT_CHARACTER_TAG } } }] };
