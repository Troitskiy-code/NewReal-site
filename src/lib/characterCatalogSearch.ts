import { characterTagSearchTerms } from "./characterTags";

/** Shared by the initial server page and subsequent API pages. */
export function catalogSearchCondition(search: string) {
  const query = search.trim().slice(0, 200);
  return query ? { OR: [
    { name: { contains: query, mode: "insensitive" as const } },
    { name_en: { contains: query, mode: "insensitive" as const } },
    ...characterTagSearchTerms(query).map(tag => ({ tags: { contains: tag, mode: "insensitive" as const } })),
  ] } : {};
}
