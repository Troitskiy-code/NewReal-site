import { FEATURED_GENRES, recommendationTags } from "@/lib/characterTags";
import { translate } from "@/lib/getDictionary";

/**
 * Pure helpers for the indexable part of a public character page: story excerpts, the 18+ guard
 * and the "similar characters" order. No database access, so scripts/verify-seo.ts imports it.
 */

export const STORY_GREETING_MAX = 900;
export const STORY_SCENARIO_MAX = 600;
export const SIMILAR_CHARACTERS_LIMIT = 8;

// Characters carry no 18+ flag (moderation only unpublishes), so explicit wording itself is the signal.
// Whole words and stems only: "cockpit", "небо", "секстант", "трахея" or "lustrous" must not match.
// Ambiguous words ("голая стена", "возбуждено дело", "naked eye") are left out on purpose.
const ADULT_PATTERNS = [
  /(?<![\p{L}\d])(?:секс(?!т)\p{L}*|порн\p{L}*|эроти\p{L}*|минет\p{L}*|оргазм\p{L}*|мастурб\p{L}*|изнасил\p{L}*|инцест\p{L}*|хентай\p{L}*|бдсм|трах(?:а|н)\p{L}*|(?:вы|за|от|по|)[её]б(?:а|ал|ат|ет|ёт|ут|ли|ля|ись|ырь)\p{L}*|отсос\p{L}*|пенис\p{L}*|вагин\p{L}*|клитор\p{L}*|сиськ\p{L}*|шлюх\p{L}*|похот\p{L}*)/iu,
  /(?<![\p{L}\d])(?:sex|sexy|sexual\p{L}*|sexting|porn\p{L}*|erotic\p{L}*|orgasm\p{L}*|masturbat\p{L}*|rape[sd]?|raping|incest\p{L}*|hentai|bdsm|nsfw|fuck\p{L}*|cocks?|pussy|cum|cumming|blowjobs?|penis|vagina\p{L}*|clitoris|boobs|tits|sluts?|whores?|horny|lust|lustful)(?![\p{L}\d])/iu,
  /(?<![\p{L}\d])18\s*\+/u,
];

export function hasAdultText(text: string | null | undefined): boolean {
  if (!text) return false;
  const comparable = text.normalize("NFKC").replace(/[­​-‏⁠-⁯﻿]/g, "");
  return ADULT_PATTERNS.some((pattern) => pattern.test(comparable));
}

/** One explicit field keeps the whole character out of indexable HTML, not only that field. */
export function isAdultCharacter(texts: ReadonlyArray<string | null | undefined>): boolean {
  return texts.some(hasAdultText);
}

export type StoryLocale = string;

/**
 * A greeting or scenario as page text: chat macros resolved, roleplay asterisks dropped and long text
 * cut at a sentence end. Returns null for empty text.
 */
export function storyExcerpt(text: string | null | undefined, name: string, locale: StoryLocale, max: number): string | null {
  const you = translate(locale, "characterStory.you");
  const value = text
    ?.replace(/\{\{char\}\}/gi, name)
    // "Привет, {{user}}!" and "{{user}}, ты пришёл" read naturally without the address.
    .replace(/,\s*\{\{user\}\}(?=\s*[,.!?…—-])/gi, "")
    .replace(/(^|[\n.!?…]\s*)\{\{user\}\}\s*,\s*(\p{L})/giu, (_, lead: string, letter: string) => `${lead}${letter.toLocaleUpperCase()}`)
    // "{{user}} is your partner" reads "you are", not "you is".
    .replace(/\{\{user\}\}(\s+)(is|was|has)\b/gi, (_, space: string, verb: string) =>
      `{{user}}${space}${locale === "en" ? ({ is: "are", was: "were", has: "have" } as Record<string, string>)[verb.toLowerCase()] : verb}`)
    .replace(/(^|[\n.!?…]\s*)\{\{user\}\}/giu, (_, lead: string) => `${lead}${you.charAt(0).toLocaleUpperCase()}${you.slice(1)}`)
    .replace(/\{\{user\}\}/gi, you)
    .replace(/\*+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!value) return null;
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  const sentenceEnd = Math.max(...[". ", "! ", "? ", "… ", ".\n", "!\n", "?\n", "…\n"].map((mark) => head.lastIndexOf(mark)));
  if (sentenceEnd >= max * 0.6) return `${head.slice(0, sentenceEnd + 1).trimEnd()} …`;
  const wordEnd = head.lastIndexOf(" ");
  return `${head.slice(0, wordEnd > max * 0.6 ? wordEnd : max - 1).trimEnd()}…`;
}

export type SimilarCandidate = { id: string; tags: string | null; totalMessages: number };

const GENRE_TAGS = new Set<string>(FEATURED_GENRES.map((genre) => genre.tag));

/**
 * Shared genres weigh more than other shared tags; ties go to the more popular character, then the
 * id, so the HTML is the same on every request. Characters without a shared tag fill the remaining
 * places by popularity.
 */
export function rankSimilarCharacters<T extends SimilarCandidate>(
  current: { id: string; tags: string | null },
  candidates: readonly T[],
  limit = SIMILAR_CHARACTERS_LIMIT,
): T[] {
  const own = new Set(recommendationTags(current.tags));
  const seen = new Set<string>([current.id]);
  const scored = candidates.flatMap((candidate) => {
    if (seen.has(candidate.id)) return [];
    seen.add(candidate.id);
    const score = recommendationTags(candidate.tags)
      .filter((tag) => own.has(tag))
      .reduce((sum, tag) => sum + (GENRE_TAGS.has(tag) ? 3 : 1), 0);
    return [{ candidate, score }];
  });
  return scored
    .sort((a, b) => b.score - a.score
      || b.candidate.totalMessages - a.candidate.totalMessages
      || (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0))
    .slice(0, limit)
    .map((item) => item.candidate);
}
