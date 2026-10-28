import { localeFallbacks } from "./i18nConfig";
import { memoryToText } from "./persistentMemory";

export const CHARACTER_TRANSLATION_FIELDS = ["name", "description", "descriptionCard", "appearance", "greeting", "scenario", "exampleDialogs", "avatarPrompt", "publicMemory"] as const;
export type CharacterTranslationField = (typeof CHARACTER_TRANSLATION_FIELDS)[number];
export type CharacterTranslation = { locale: string } & Partial<Record<CharacterTranslationField, string | null>>;
export type LocalizableCharacter = Partial<Record<CharacterTranslationField, unknown>> & {
  translations?: readonly CharacterTranslation[];
  name_en?: string | null; description_en?: string | null; descriptionCard_en?: string | null;
  appearance_en?: string | null; greeting_en?: string | null; scenario_en?: string | null;
  exampleDialogs_en?: string | null; avatarPrompt_en?: string | null; publicMemory_en?: unknown;
};

/** Never select private memory, legacy prompts or translation bookkeeping into public responses. */
export const publicTranslationSelect = {
  locale: true, name: true, description: true, descriptionCard: true,
  publicMemory: true,
} as const;
export const previewTranslationSelect = { ...publicTranslationSelect, greeting: true } as const;
export const storyTranslationSelect = { locale: true, greeting: true, scenario: true } as const;
export const chatTranslationSelect = { ...previewTranslationSelect, scenario: true, appearance: true, exampleDialogs: true } as const;

export function localizedCharacterText(character: LocalizableCharacter | null | undefined, field: CharacterTranslationField | readonly CharacterTranslationField[], locale: string | null | undefined): string | null {
  if (!character) return null;
  const fields: readonly CharacterTranslationField[] = typeof field === "string" ? [field] : field;
  for (const code of localeFallbacks(locale)) {
    for (const field of fields) {
      const translated = character.translations?.find((item) => item.locale === code)?.[field]?.trim();
      if (translated) return translated;
      if (code === "en") {
        const legacy = character[`${field}_en` as keyof LocalizableCharacter];
        const text = field === "publicMemory" ? memoryToText(legacy) : typeof legacy === "string" ? legacy : "";
        if (text.trim()) return text;
      }
      if (code === "ru") {
        const original = character[field];
        const text = field === "publicMemory" ? memoryToText(original) : typeof original === "string" ? original : "";
        if (text.trim()) return text;
      }
    }
  }
  return null;
}
