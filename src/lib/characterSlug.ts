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

export function buildCharacterSlug(name: string, characterId: string, extra?: string): string {
  const base = slugifyCharacterName(name);
  const suffix = characterSlugSuffix(characterId);
  return extra ? `${base}-${suffix}-${extra}` : `${base}-${suffix}`;
}

export function temporaryCharacterSlug(): string {
  return `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
