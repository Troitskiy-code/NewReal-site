import { ClientInputError } from "./publicError";
import { normalizeTagsString } from "@/lib/characterTags";
import { parseMemoryInput, parseMemoryPermissionsInput, memoryToText } from "@/lib/persistentMemory";
import { isEnglishLocale } from "@/lib/i18nConfig";
import { parseRoleplayFields } from "./roleplayConfig";

export const CHARACTER_LIMITS = {
  appearance: 2000,
  description: 5000,
  greeting: 2000,
  scenario: 1500,
  exampleDialogs: 3000,
  descriptionCard: 700,
  avatarPrompt: 1000,
} as const;

export function trimOptionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new ClientInputError(`Поле превышает лимит ${maxLength} символов`);
  }
  return trimmed;
}

export function parseCharacterBody(body: Record<string, unknown>) {
  const {
    name,
    description,
    descriptionCard,
    appearance,
    tags,
    imageUrl,
    imageLora,
    isPublic,
    greeting,
    scenario,
    exampleDialogs,
    avatarPrompt,
  } = body;

  const tagsValue = normalizeTagsString(typeof tags === "string" ? tags : null);

  return {
    ...parseRoleplayFields(body),
    name: typeof name === "string" ? name.trim() : "",
    description: trimOptionalText(description, CHARACTER_LIMITS.description),
    descriptionCard: trimOptionalText(descriptionCard, CHARACTER_LIMITS.descriptionCard),
    appearance: trimOptionalText(appearance, CHARACTER_LIMITS.appearance),
    tags: tagsValue || null,
    imageUrl: typeof imageUrl === "string" ? imageUrl || null : imageUrl === null ? null : undefined,
    imageLora: typeof imageLora === "string" ? imageLora || null : imageLora === null ? null : undefined,
    isPublic: Boolean(isPublic),
    greeting: trimOptionalText(greeting, CHARACTER_LIMITS.greeting),
    scenario: trimOptionalText(scenario, CHARACTER_LIMITS.scenario),
    exampleDialogs: trimOptionalText(exampleDialogs, CHARACTER_LIMITS.exampleDialogs),
    avatarPrompt: trimOptionalText(avatarPrompt, CHARACTER_LIMITS.avatarPrompt),
    publicMemory: parseMemoryInput(body.publicMemory),
    privateMemory: parseMemoryInput(body.privateMemory),
    memoryPermissions: parseMemoryPermissionsInput(body.memoryPermissions),
  };
}

export function getCardDescription(character: {
  descriptionCard?: string | null;
  description?: string | null;
}): string | null {
  return character.descriptionCard?.trim() || character.description?.trim() || null;
}

export function pickLocalizedText(
  original: string | null | undefined,
  translated: string | null | undefined,
  locale: string | null | undefined
): string | null {
  if (isEnglishLocale(locale) && translated?.trim()) {
    return translated;
  }
  return original?.trim() || null;
}

export function getLocalizedCardDescription(
  character: {
    descriptionCard?: string | null;
    descriptionCard_en?: string | null;
    description?: string | null;
    description_en?: string | null;
  },
  locale: string | null | undefined
): string | null {
  if (isEnglishLocale(locale)) {
    return (
      character.descriptionCard_en?.trim() ||
      character.description_en?.trim() ||
      character.descriptionCard?.trim() ||
      character.description?.trim() ||
      null
    );
  }
  return getCardDescription(character);
}

/** Card blurbs often open with "Name — …"; drop the echo because the title is shown right above. */
export function stripLeadingName(text: string, name: string | null | undefined): string {
  const base = name?.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!base) return text;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escaped}\\s*[—–-]\\s*`, "i"));
  const rest = match ? text.slice(match[0].length) : "";
  return rest ? rest.charAt(0).toLocaleUpperCase() + rest.slice(1) : text;
}

export function pickLocalizedMemory(
  original: unknown,
  translated: unknown,
  locale: string | null | undefined
): string {
  if (isEnglishLocale(locale)) {
    return memoryToText(translated).trim() || memoryToText(original).trim();
  }
  return memoryToText(original).trim();
}
