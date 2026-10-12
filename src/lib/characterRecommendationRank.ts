import { recommendationTags, CHARACTER_TAG_GROUPS } from "./characterTags";

export type RecommendationCard = { id: string; tags: string | null; roleplayMode: string | null; totalMessages: number; createdAt: Date };
export type RecommendationSignal = { characterId: string; tags: string | null; roleplayMode: string | null; weight: number };
export type RecommendationMode = "personalized" | "discovery";

function seedHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}
const genreTags = new Set<string>(CHARACTER_TAG_GROUPS[0].tags);

/** Deterministic within a day: diversity is applied before slicing, not once per page. */
export function rankRecommendedCharacters(cards: RecommendationCard[], signals: RecommendationSignal[], seed: string, now: Date) {
  const preferences = new Map<string, number>(), modes = new Map<string, number>(), familiar = new Set<string>();
  for (const signal of signals) {
    if (!(signal.weight > 0) || !Number.isFinite(signal.weight)) continue;
    familiar.add(signal.characterId);
    for (const tag of recommendationTags(signal.tags)) preferences.set(tag, (preferences.get(tag) ?? 0) + signal.weight);
    if (signal.roleplayMode) modes.set(signal.roleplayMode, (modes.get(signal.roleplayMode) ?? 0) + signal.weight);
  }
  const maxPreference = Math.max(1, ...preferences.values()), maxMode = Math.max(1, ...modes.values());
  const mode: RecommendationMode = preferences.size || modes.size ? "personalized" : "discovery";
  const maxPopularity = Math.max(1, ...cards.map(card => Math.log1p(Math.max(0, card.totalMessages))));
  const pool = cards.map(card => {
    const tags = recommendationTags(card.tags);
    const matches = tags.map(tag => (preferences.get(tag) ?? 0) / maxPreference).sort((a, b) => b - a).slice(0, 3);
    const relevance = matches.reduce((sum, value, i) => sum + value / (i + 1), 0);
    const modeMatch = (modes.get(card.roleplayMode ?? "") ?? 0) / maxMode;
    const ageDays = Math.max(0, (now.getTime() - card.createdAt.getTime()) / 86400000);
    const quality = Math.log1p(Math.max(0, card.totalMessages)) / maxPopularity;
    return { card, tags, score: 4 * relevance + 0.6 * modeMatch + 0.65 * quality + 0.45 * Math.exp(-ageDays / 30)
      + 0.5 * seedHash(`${seed}:${card.id}`) - (familiar.has(card.id) ? 3 : 0) };
  });
  const ordered: string[] = [], recentGenres: string[] = [];
  while (pool.length) {
    let bestIndex = 0, bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      const repeated = item.tags.filter(tag => genreTags.has(tag)).reduce((max, tag) => Math.max(max, recentGenres.filter(other => other === tag).length), 0);
      const score = item.score - repeated * 1.4;
      if (score > bestScore || (score === bestScore && item.card.id < pool[bestIndex].card.id)) { bestScore = score; bestIndex = i; }
    }
    const [chosen] = pool.splice(bestIndex, 1);
    ordered.push(chosen.card.id);
    recentGenres.push(...chosen.tags.filter(tag => genreTags.has(tag)));
    if (recentGenres.length > 6) recentGenres.splice(0, recentGenres.length - 6);
  }
  return { ids: ordered, mode };
}
