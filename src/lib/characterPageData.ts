import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import { findCharacterBySlugForViewer, getViewerId, toPublicCharacterPayload } from "@/lib/characterPublic";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { withLocale } from "@/lib/i18nConfig";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export const getCharacterPageData = cache(async (slug: string) => {
  const locale = await getRequestLocale();
  const viewerId = await getViewerId();
  let character;
  try {
    character = await findCharacterBySlugForViewer(slug, viewerId);
  } catch (error) {
    errorLog("Character", "public page lookup", toSafeDiagnostic(error));
    // A failed lookup must not mark an existing page as deleted or disclose DB errors.
    throw new Error("Public character temporarily unavailable");
  }
  if (!character) notFound();
  if (slug !== character.slug) permanentRedirect(withLocale(`/character/${character.slug}`, locale));
  return { character, locale, view: {
    ...toPublicCharacterPayload(character, viewerId),
    createdAt: character.createdAt.toISOString(),
    updatedAt: character.updatedAt.toISOString(),
  } };
});
