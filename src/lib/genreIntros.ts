import type { Locale } from "@/lib/i18nConfig";
import type { GenreId } from "@/lib/genreSeo";
import { localizedValue } from "@/lib/getDictionary";

/** Page copy lives in locale dictionaries, with the same fallback as the interface. */
export function genreIntro(id: GenreId, locale: Locale): string[] {
  return localizedValue<string[]>(locale, `genreIntros.${id}`) ?? [];
}
