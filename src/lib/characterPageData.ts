import { cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { findCharacterBySlugForViewer, getViewerId, toPublicCharacterPayload } from "@/lib/characterPublic";
import { catalogTagCondition } from "@/lib/characterCatalogSearch";
import { recommendationTags } from "@/lib/characterTags";
import { isAdultCharacter, rankSimilarCharacters, SIMILAR_CHARACTERS_LIMIT } from "@/lib/characterSeoContent";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { withLocale } from "@/lib/i18nConfig";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { memoryToText } from "@/lib/persistentMemory";

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

type AdultCheckFields = {
  name: string; name_en: string | null; description: string | null; description_en: string | null;
  descriptionCard: string | null; descriptionCard_en: string | null; tags: string | null;
  greeting: string | null; greeting_en: string | null; scenario: string | null; scenario_en: string | null;
  publicMemory?: unknown; publicMemory_en?: unknown;
};

const adultCheckSelect = {
  name: true, name_en: true, description: true, description_en: true, descriptionCard: true, descriptionCard_en: true,
  tags: true, greeting: true, greeting_en: true, scenario: true, scenario_en: true,
} as const;

function isAdultCard(card: AdultCheckFields): boolean {
  return isAdultCharacter([
    card.name, card.name_en, card.description, card.description_en, card.descriptionCard, card.descriptionCard_en, card.tags,
    card.greeting, card.greeting_en, card.scenario, card.scenario_en, memoryToText(card.publicMemory), memoryToText(card.publicMemory_en),
  ]);
}

/**
 * The first message and the scenario for the page body. `adult` keeps the page out of the index and
 * hides both fields; a failed read leaves the page as it was before these blocks existed.
 */
export const getCharacterStory = cache(async (slug: string) => {
  const { character } = await getCharacterPageData(slug);
  try {
    const story = await prisma.character.findUnique({
      where: { id: character.id },
      select: { greeting: true, greeting_en: true, scenario: true, scenario_en: true },
    });
    if (!story) return { adult: false, story: null };
    const adult = isAdultCard({ ...character, ...story });
    return { adult, story: adult ? null : story };
  } catch (error) {
    errorLog("Character", "public story", toSafeDiagnostic(error));
    return { adult: false, story: null };
  }
});

const similarCardSelect = { id: true, slug: true, totalMessages: true, updatedAt: true } as const;

/** Public characters sharing genres or tags, in a fixed order; explicit cards are never linked. */
export async function getSimilarCharacters(character: { id: string; tags: string | null }) {
  const where = {
    isPublic: true, slug: { not: null }, imageUrl: { not: null }, id: { not: character.id },
    OR: [{ moderationStatus: null }, { moderationStatus: { not: "warning" } }],
  };
  const select = { ...similarCardSelect, ...adultCheckSelect, publicMemory: true, publicMemory_en: true };
  const orderBy = [{ totalMessages: "desc" as const }, { id: "asc" as const }];
  try {
    const tags = recommendationTags(character.tags);
    const [related, popular] = await Promise.all([
      tags.length
        ? prisma.character.findMany({ where: { AND: [where, { OR: tags.flatMap((tag) => catalogTagCondition(tag).OR) }] }, select, orderBy, take: 120 })
        : Promise.resolve([]),
      prisma.character.findMany({ where, select, orderBy, take: SIMILAR_CHARACTERS_LIMIT * 3 }),
    ]);
    const safe = [...related, ...popular].filter((card) => !isAdultCard(card));
    return rankSimilarCharacters(character, safe).map((card) => ({
      id: card.id, slug: card.slug ?? "", name: card.name, name_en: card.name_en, tags: card.tags, updatedAt: card.updatedAt,
    }));
  } catch (error) {
    errorLog("Character", "similar characters", toSafeDiagnostic(error));
    return [];
  }
}

/** Sitemap: public characters whose page is indexable (explicit cards are noindex). */
export async function getIndexableCharacterRows() {
  const rows = await prisma.character.findMany({
    where: { isPublic: true, slug: { not: null } },
    select: { id: true, slug: true, updatedAt: true, ...adultCheckSelect, publicMemory: true, publicMemory_en: true },
  });
  return rows.filter((row) => !isAdultCard(row)).map(({ id, slug, updatedAt }) => ({ id, slug, updatedAt }));
}
