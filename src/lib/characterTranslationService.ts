import { CHARACTER_TRANSLATION_FIELDS, type CharacterTranslationField } from "./characterLocalization";
import { memoryToText } from "./persistentMemory";
import { translateText } from "./translate";
import { characterTranslationSource, type TranslationSource } from "./characterTranslationData";
export { characterTranslationSource, characterTranslationHash, type TranslationSource } from "./characterTranslationData";

/** A failed field rejects the whole translation, so untranslated source text is never marked complete. */
export async function translateCharacterContent(source: TranslationSource, locale: string) {
  const content = characterTranslationSource(source);
  const result: Record<string, string | null> = {};
  for (const field of CHARACTER_TRANSLATION_FIELDS) {
    const value = content[field];
    const legacy = field === "publicMemory" ? memoryToText(source.publicMemory_en) : source[`${field}_en`];
    result[field] = !value ? null : locale === "en" && typeof legacy === "string" && legacy.trim()
      ? legacy : await translateText(value, locale, 30_000);
  }
  return result as Record<CharacterTranslationField, string | null>;
}
