import { prisma } from "@/lib/prisma";
import { previewTranslationSelect, type CharacterTranslation } from "./characterLocalization";
import { characterAvatarPath } from "@/lib/characterCardImage";
import { getViewerId } from "@/lib/characterPublic";
import { withTelegramCharacterWhere } from "@/lib/telegram/catalog";
import { recommendationTags } from "@/lib/characterTags";
import {
  ONBOARDING_GENDER_TAGS, matchedOnboardingInterests, resolveArtStyle,
  type OnboardingGender, type OnboardingInterest, type OnboardingStyle,
} from "@/lib/onboarding";

export const ONBOARDING_PAGE_SIZE = 3;
const GREETING_SNIPPET = 240;

export type OnboardingQuery = { style: OnboardingStyle | null; interests: OnboardingInterest[]; gender: OnboardingGender | null; page: number };
export type OnboardingCandidate = {
  translations?: CharacterTranslation[];
  id: string; slug: string | null; name: string; name_en: string | null;
  descriptionCard: string | null; descriptionCard_en: string | null; description: string | null; description_en: string | null;
  greeting: string | null; greeting_en: string | null; tags: string | null; artStyle: string | null;
  totalMessages: number; createdAt: Date; updatedAt: Date;
};

function seedHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}
function snippet(text: string | null) {
  const value = text?.replace(/\{\{user\}\}/gi, "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  return value.length > GREETING_SNIPPET ? `${value.slice(0, GREETING_SNIPPET - 1).trimEnd()}…` : value;
}

/**
 * Pure ranking, exported for tests. A definite style mismatch is dropped; an unclassified card stays
 * eligible behind classified matches, so the picker works before the style backfill finishes.
 */
export function rankOnboardingCandidates(cards: OnboardingCandidate[], query: Omit<OnboardingQuery, "page">, seed: string) {
  const genderTag = query.gender ? ONBOARDING_GENDER_TAGS[query.gender] : null;
  const otherGenderTag = query.gender ? ONBOARDING_GENDER_TAGS[query.gender === "male" ? "female" : "male"] : null;
  const maxPopularity = Math.max(1, ...cards.map(card => Math.log1p(Math.max(0, card.totalMessages))));
  const scored = cards.flatMap(card => {
    const style = resolveArtStyle(card.artStyle, card.tags);
    const wantsStyle = query.style && query.style !== "any";
    if (wantsStyle && style && style !== query.style) return [];
    const tags = recommendationTags(card.tags);
    const matched = matchedOnboardingInterests(card.tags, query.interests);
    const genderScore = !genderTag ? 0 : tags.includes(genderTag) ? 0.8 : tags.includes(otherGenderTag!) ? -2.5 : 0;
    const styleScore = !wantsStyle ? 0 : style ? 1.5 : 0;
    const score = 3 * matched.length + styleScore + genderScore + 0.9 * Math.log1p(Math.max(0, card.totalMessages)) / maxPopularity
      + (card.greeting ? 0.3 : 0) + 0.35 * seedHash(`${seed}:${card.id}`);
    return [{ card, matched, score }];
  });
  // Diversity: a trio should not be three cards of the same single interest.
  const matchedPool = scored.filter(item => item.matched.length).sort((a, b) => b.score - a.score || (a.card.id < b.card.id ? -1 : 1));
  const ordered: typeof matchedPool = [];
  while (matchedPool.length) {
    const inTrio = ordered.slice(ordered.length - (ordered.length % ONBOARDING_PAGE_SIZE));
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < matchedPool.length; i++) {
      const lead = matchedPool[i].matched[0];
      const repeats = inTrio.filter(item => item.matched[0] === lead).length;
      const value = matchedPool[i].score - (repeats >= 1 && query.interests.length > 1 ? 1.2 * repeats : 0);
      if (value > bestScore) { bestScore = value; best = i; }
    }
    ordered.push(...matchedPool.splice(best, 1));
  }
  const fallback = scored.filter(item => !item.matched.length).sort((a, b) => b.score - a.score || (a.card.id < b.card.id ? -1 : 1));
  return { matchedCount: ordered.length, ordered: [...ordered.map(item => ({ ...item, fallback: false })), ...fallback.map(item => ({ ...item, fallback: true }))] };
}

export async function getOnboardingPicks(query: OnboardingQuery, now = new Date()) {
  const cards: OnboardingCandidate[] = await prisma.character.findMany({
    // Only cards a newcomer can open right away: public, with a page, an avatar and no moderation warning.
    where: await withTelegramCharacterWhere({ isPublic: true, slug: { not: null }, imageUrl: { not: null }, OR: [{ moderationStatus: null }, { moderationStatus: { not: "warning" } }] }, await getViewerId()),
    select: {
      translations: { select: previewTranslationSelect },
      id: true, slug: true, name: true, name_en: true, descriptionCard: true, descriptionCard_en: true, description: true, description_en: true,
      greeting: true, greeting_en: true, tags: true, artStyle: true, totalMessages: true, createdAt: true, updatedAt: true,
    },
  });
  const { matchedCount, ordered } = rankOnboardingCandidates(cards, query, now.toISOString().slice(0, 10));
  const pages = Math.max(1, Math.ceil(ordered.length / ONBOARDING_PAGE_SIZE));
  const start = (Math.max(0, query.page) % pages) * ONBOARDING_PAGE_SIZE;
  const picks = ordered.slice(start, start + ONBOARDING_PAGE_SIZE);
  return {
    total: matchedCount,
    pages,
    characters: picks.map(({ card, matched, fallback }) => ({
      id: card.id, slug: card.slug, name: card.name, name_en: card.name_en,
      translations: card.translations?.map((text) => ({ ...text, greeting: snippet(text.greeting) })),
      descriptionCard: card.descriptionCard, descriptionCard_en: card.descriptionCard_en,
      description: card.description, description_en: card.description_en,
      greeting: snippet(card.greeting), greeting_en: snippet(card.greeting_en),
      tags: recommendationTags(card.tags), avatarUrl: characterAvatarPath(card.id, card.updatedAt),
      matched, fallback,
    })),
  };
}
export type OnboardingPicks = Awaited<ReturnType<typeof getOnboardingPicks>>;
