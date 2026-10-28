import { createHash } from "node:crypto";
import { CHARACTER_TRANSLATION_FIELDS, type CharacterTranslationField } from "./characterLocalization";
import { memoryToText } from "./persistentMemory";

export type TranslationSource = Partial<Record<CharacterTranslationField, unknown>> & Record<string, unknown>;
export const characterTranslationSourceSelect = {
  id: true, isPublic: true,
  ...Object.fromEntries(CHARACTER_TRANSLATION_FIELDS.map(field => [field, true])) as Record<CharacterTranslationField, true>,
  ...Object.fromEntries(CHARACTER_TRANSLATION_FIELDS.map(field => [`${field}_en`, true])) as Record<`${CharacterTranslationField}_en`, true>,
} as const;
export function characterTranslationSource(source: TranslationSource): Record<CharacterTranslationField, string | null> {
  return Object.fromEntries(CHARACTER_TRANSLATION_FIELDS.map((field) => {
    const value = field === "publicMemory" ? memoryToText(source[field]) : source[field];
    return [field, typeof value === "string" && value.trim() ? value : null];
  })) as Record<CharacterTranslationField, string | null>;
}
export function characterTranslationHash(source: TranslationSource, locale?: string): string {
  const legacy = locale === "en" ? CHARACTER_TRANSLATION_FIELDS.map(field => source[`${field}_en`] ?? null) : null;
  return createHash("sha256").update(JSON.stringify([characterTranslationSource(source), legacy])).digest("hex");
}
