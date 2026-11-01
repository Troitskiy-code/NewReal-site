const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

export function slugifyCharacterName(name: string): string {
  const transliterated = name
    .trim()
    .toLowerCase()
    .split("")
    .map((char) => CYRILLIC_TO_LATIN[char] ?? char)
    .join("");

  const slug = transliterated
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || "character";
}

export function characterSlugSuffix(characterId: string): string {
  return characterId.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase() || "id";
}

/** Id-suffix candidates of a slug built by buildCharacterSlug: `name-<suffix>` or `name-<suffix>-<extra>`. */
export function renamedSlugSuffixes(slug: string): string[] {
  const parts = slug.toLowerCase().split("-");
  return parts.slice(-2).filter(part => /^[a-z0-9]{8}$/.test(part)).reverse();
}

/** Query string of a page request (with "?"), so redirects keep UTM tags and other parameters. */
export function pageQueryString(searchParams: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function buildCharacterSlug(name: string, characterId: string, extra?: string): string {
  const base = slugifyCharacterName(name);
  const suffix = characterSlugSuffix(characterId);
  return extra ? `${base}-${suffix}-${extra}` : `${base}-${suffix}`;
}

export function temporaryCharacterSlug(): string {
  return `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
