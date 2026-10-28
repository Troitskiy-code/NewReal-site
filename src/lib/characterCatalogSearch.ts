import { characterTagSearchTerms } from "./characterTags";

/** Genre pages match the same tag spellings as a genre chip typed into the catalog search. */
export function catalogTagCondition(tag: string) {
  return { OR: characterTagSearchTerms(tag).map(term => ({ tags: { contains: term, mode: "insensitive" as const } })) };
}

/** Shared by the initial server page and subsequent API pages. */
export function catalogSearchCondition(search: string) {
  const query = search.trim().slice(0, 200);
  return query ? { OR: [
    { name: { contains: query, mode: "insensitive" as const } },
    { name_en: { contains: query, mode: "insensitive" as const } },
    { translations: { some: { name: { contains: query, mode: "insensitive" as const } } } },
    ...catalogTagCondition(query).OR,
  ] } : {};
}
