import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rankRecommendedCharacters, type RecommendationSignal } from "./characterRecommendationRank";
import { ONBOARDING_GENDER_TAGS, onboardingInterestTags, type OnboardingPrefs } from "./onboarding";
import { joinTagsString } from "./characterTags";

/** No message text, prompts or private memory are read. No cross-request personalized cache. */
export async function getCharacterRecommendationOrder(where: Prisma.CharacterWhereInput, viewerId: string | null, now = new Date(),
  onboarding: OnboardingPrefs | null = null) {
  const publicWhere: Prisma.CharacterWhereInput = { AND: [where, { isPublic: true, slug: { not: null } }] };
  const candidates = await prisma.character.findMany({ where: publicWhere, select: {
    id: true, tags: true, roleplayMode: true, totalMessages: true, createdAt: true, artStyle: true,
  } });
  const signals: RecommendationSignal[] = [];
  // "Первый шаг" answers weigh like one favorite: a cold start, soon outweighed by real chats.
  const onboardingTags = onboarding ? [...onboardingInterestTags(onboarding.interests), ...(onboarding.gender ? [ONBOARDING_GENDER_TAGS[onboarding.gender]] : [])] : [];
  if (onboardingTags.length) signals.push({ characterId: "onboarding", tags: joinTagsString(onboardingTags), roleplayMode: null, weight: 3 });
  if (viewerId) {
    const [favorites, activity] = await Promise.all([
      prisma.favorite.findMany({ where: { userId: viewerId, character: { isPublic: true, slug: { not: null } } },
        select: { characterId: true, character: { select: { tags: true, roleplayMode: true } } },
        orderBy: [{ createdAt: "desc" }, { characterId: "asc" }], take: 100 }),
      prisma.message.groupBy({ by: ["characterId"], where: { userId: viewerId, role: "assistant", isAutoEvent: false,
        content: { not: "" }, createdAt: { gte: new Date(now.getTime() - 60 * 86400000) },
        character: { isPublic: true, slug: { not: null } } }, _count: { id: true }, _max: { createdAt: true },
        orderBy: [{ _max: { createdAt: "desc" } }, { characterId: "asc" }], take: 100 }),
    ]);
    for (const favorite of favorites) signals.push({ characterId: favorite.characterId, ...favorite.character, weight: 3 });
    if (activity.length) {
      const cards = await prisma.character.findMany({ where: { id: { in: activity.map(row => row.characterId) }, isPublic: true, slug: { not: null } },
        select: { id: true, tags: true, roleplayMode: true } });
      for (const row of activity) {
        const card = cards.find(item => item.id === row.characterId);
        if (!card) continue;
        const ageDays = Math.max(0, (now.getTime() - (row._max.createdAt?.getTime() ?? 0)) / 86400000);
        const weight = Math.min(3, Math.log2(1 + row._count.id)) * Math.exp(-ageDays / 30);
        signals.push({ characterId: row.characterId, tags: card.tags, roleplayMode: card.roleplayMode, weight });
      }
    }
  }
  // Day bucket changes discovery without shuffling between pages/SSR and API requests.
  const preferredStyle = onboarding?.style && onboarding.style !== "any" ? onboarding.style : null;
  return rankRecommendedCharacters(candidates, signals, `${viewerId ?? "guest"}:${now.toISOString().slice(0, 10)}`, now, { preferredStyle });
}
