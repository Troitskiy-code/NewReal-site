import { normalizeTagsString } from "@/lib/characterTags";

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
    throw new Error(`Поле превышает лимит ${maxLength} символов`);
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
  };
}

export function getCardDescription(character: {
  descriptionCard?: string | null;
  description?: string | null;
}): string | null {
  return character.descriptionCard?.trim() || character.description?.trim() || null;
}
