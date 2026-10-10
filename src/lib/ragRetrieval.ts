import { sameMemoryMeaning, memoryTerms } from "./memoryNarrative";

export type RagSourceMessage = {
  id: string;
  role: string;
  content: string;
  createdAt?: Date;
};

export type RagMessage = RagSourceMessage & {
  similarity: number;
  /** A single, chronologically ordered excerpt: preceding turn, anchor, following turn. */
  context?: RagSourceMessage[];
};

export type RagExcerpt = {
  anchorId: string;
  messages: RagSourceMessage[];
  line: string;
};

const QUERY_CHARS = 1200;
const CONTEXT_CHARS = 480;
export const RAG_EXCERPT_MAX_CHARS = 12000;
const FILLER_WORDS = new Set(["ну", "вот", "же", "ведь", "кстати", "итак", "well", "indeed"]);
const CONTEXT_REFERENCE_RE = /(?:^|[^\p{L}])(?:он|она|они|его|её|ее|ему|ей|им|их|это|этот|эта|эти|этого|этой|этих|том|там|туда|тогда|так|снова|ещё|еще|наш|наша|наше|наши|дальше|it|he|she|they|them|that|those|there|our|again)(?=$|[^\p{L}])/iu;
const CONTINUE_QUERY_RE = /^(?:а\s+)?(?:продолжай|продолжи|продолжить|continue|what next)(?:\s|[?.!,]|$)/iu;

/** Limit both the search query and its SQL snapshot to the actual turn, not a racing later turn. */
export function limitRagHistoryToQuery<T extends RagSourceMessage>(history: T[], excludeMessageId?: string): T[] {
  const index = history.findIndex(row => row.id === excludeMessageId);
  if (index >= 0) return history.slice(0, index + 1);
  return history;
}

function compact(text: string, limit: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= limit) return normalized;
  const prefix = normalized.slice(0, limit - 1);
  const boundary = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, boundary > limit / 2 ? boundary : prefix.length)}…`;
}

/** Uses the already loaded history and exactly one query embedding. Current query is repeated for weight. */
export function buildRagSearchQuery(
  currentQuery: string,
  history: RagSourceMessage[] = [],
  excludeMessageId?: string
): string {
  const query = compact(currentQuery, QUERY_CHARS);
  if (!query) return "";
  // Unrelated recent topics must not drown out a self-contained question.
  if (!CONTEXT_REFERENCE_RE.test(query) && !CONTINUE_QUERY_RE.test(query)) return query;
  const rows = limitRagHistoryToQuery(history, excludeMessageId).filter(row => row.role === "user" || row.role === "assistant");
  // Normal/retry/regenerate may already have the query as the last stored turn;
  // continue uses the last assistant turn. Never use a later turn as query context.
  let currentIndex = rows.findIndex(row => row.id === excludeMessageId);
  if (currentIndex < 0 && rows.at(-1)?.content.trim() === currentQuery.trim()) currentIndex = rows.length - 1;
  const previous = (currentIndex >= 0 ? rows.slice(0, currentIndex) : rows).slice(-2);
  if (!previous.length) return query;
  const budget = Math.min(CONTEXT_CHARS, Math.max(160, query.length));
  const perTurn = Math.floor(budget / previous.length);
  const context = previous.map(row => `${row.role}: ${compact(row.content, perTurn)}`).join("\n");
  return `${query}\n\nRecent conversation (context only):\n${context}\n\nCurrent query: ${query}`;
}

function duplicateSignature(text: string): string {
  return (text.toLowerCase().replace(/ё/gu, "е").match(/[\p{L}\p{N}]+(?:[.,]\d+)?|[%₽$€£¥?]/gu) ?? [])
    .filter(word => !FILLER_WORDS.has(word)).join(" ");
}

/** Deliberately stricter than semantic similarity: one changed detail must not be erased. */
export function areDuplicateRagMessages(left: RagMessage, right: RagMessage): boolean {
  // Two identical "yes" replies can accept different proposals. Even long anchors
  // can have different following corrections: compare the whole available excerpt.
  if (left.role !== right.role || left.content.length > RAG_EXCERPT_MAX_CHARS || right.content.length > RAG_EXCERPT_MAX_CHARS
    || memoryTerms(left.content).size < 4 || memoryTerms(right.content).size < 4) return false;
  const leftText = (left.context ?? [left]).map(row => `${row.role}: ${row.content}`).join("\n");
  const rightText = (right.context ?? [right]).map(row => `${row.role}: ${row.content}`).join("\n");
  if (leftText.length > RAG_EXCERPT_MAX_CHARS || rightText.length > RAG_EXCERPT_MAX_CHARS) return false;
  return duplicateSignature(leftText) === duplicateSignature(rightText) && sameMemoryMeaning(leftText, rightText);
}

function overlap(left: Set<string>, right: Set<string>): number {
  const common = [...left].filter(term => right.has(term)).length;
  return common / Math.max(left.size + right.size - common, 1);
}

/** Relevance first, then a small topic-repetition penalty; no extra model/embedding calls. */
export function selectDiverseRagCandidates<T extends RagMessage>(
  candidates: T[], currentQuery: string, limit: number, threshold: number
): T[] {
  const queryTerms = memoryTerms(currentQuery.slice(0, QUERY_CHARS));
  const pool = candidates.filter(row => (row.role === "user" || row.role === "assistant")
    && row.content.trim() && Number.isFinite(row.similarity) && row.similarity > threshold);
  const chosen: T[] = [];
  const terms = new Map(pool.map(row => [row.id, memoryTerms(row.content.slice(0, 12000))]));
  while (chosen.length < limit && pool.length) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    pool.forEach((candidate, index) => {
      if (chosen.some(row => row.id === candidate.id || areDuplicateRagMessages(row, candidate))) return;
      const candidateTerms = terms.get(candidate.id)!;
      const queryMatch = [...queryTerms].filter(term => candidateTerms.has(term)).length / Math.max(queryTerms.size, 1);
      const repetition = Math.max(0, ...chosen.map(row => overlap(candidateTerms, terms.get(row.id)!)));
      const score = candidate.similarity + 0.15 * queryMatch - 0.12 * repetition;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    });
    if (bestIndex < 0) break;
    chosen.push(pool.splice(bestIndex, 1)[0]);
  }
  return chosen;
}

export function formatRagLine(message: Pick<RagSourceMessage, "role" | "content">, locale?: string): string {
  const english = locale === "en";
  const speaker = message.role === "user" ? (english ? "User" : "Пользователь") : english ? "Character" : "Персонаж";
  return `- ${speaker}: ${message.content.replace(/\s*\n\s*/gu, " ").trim()}`;
}

function compareSources(left: RagSourceMessage, right: RagSourceMessage): number {
  return (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0) || left.id.localeCompare(right.id);
}

function excerptLine(messages: RagSourceMessage[], locale?: string): string {
  const at = messages[0]?.createdAt;
  const title = locale === "en" ? "Past conversation excerpt" : "Фрагмент прошлой переписки";
  const date = at && Number.isFinite(at.getTime()) ? ` · ${at.toISOString()}` : "";
  return `${title}${date}\n${messages.map(message => formatRagLine(message, locale)).join("\n")}`;
}

/** Fit whole excerpts, so a budget cannot leave just an isolated acceptance/cancellation. */
export function fitRagExcerpts(
  candidates: RagMessage[], recentIds: Set<string>, budget: number,
  countTokens: (text: string) => number, locale?: string
): RagExcerpt[] {
  const kept: RagExcerpt[] = [];
  const usedIds = new Set<string>();
  let used = 0;
  for (const candidate of candidates) {
    if (recentIds.has(candidate.id) || usedIds.has(candidate.id)) continue;
    const seen = new Set<string>();
    const messages = [...(candidate.context ?? []), candidate].filter(row => {
      if ((row.role !== "user" && row.role !== "assistant") || seen.has(row.id) || recentIds.has(row.id) || usedIds.has(row.id)) return false;
      seen.add(row.id);
      return true;
    }).sort(compareSources);
    const line = excerptLine(messages, locale);
    // Skip, never truncate an assertion halfway through; bound tokenizer work.
    if (line.length > RAG_EXCERPT_MAX_CHARS) continue;
    const tokens = countTokens(line) + 1;
    if (!messages.length || used + tokens > budget) continue;
    kept.push({ anchorId: candidate.id, messages, line });
    messages.forEach(row => usedIds.add(row.id));
    used += tokens;
  }
  return kept.sort((left, right) => compareSources(left.messages[0], right.messages[0]));
}

/** Remove quotes already present in the final history without filling the freed room again. */
export function excludeRecentRagSources(excerpts: RagExcerpt[], recentIds: Set<string>, locale?: string): RagExcerpt[] {
  return excerpts.flatMap(excerpt => {
    const messages = excerpt.messages.filter(row => !recentIds.has(row.id));
    return messages.length ? [{ ...excerpt, messages, line: excerptLine(messages, locale) }] : [];
  });
}
