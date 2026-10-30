import { CHAPTER_COMPRESSION_RULES, CHAPTER_SUMMARY_RULES, GROUNDED_SUMMARY_RULES, makeSummarySources, OUTCOME_COMPRESSION_RULES,
  OUTCOMES_HEADING, renderGroundedSummary, sourcesFromSummaries, type SummaryParticipants, type SummaryRenderDiagnostics } from "./memorySummaryEvidence";
import { MemorySummaryError, pastItemLimit, SUMMARY_ITEM_MAX_CHARS, summaryItemLimit } from "./memorySummaryPolicy";
import { sameMemoryMeaning } from "./memoryNarrative";

/**
 * A long story's summary is a list of chapters under «## Предыстория», one line each, followed by
 * the current sections (situation, decisions, plans). A chapter is written once from its own
 * messages and never re-told; only when the summary outgrows its allowance are the two oldest
 * chapters compressed into one. Re-telling the whole past on every merge kept ~30% of a
 * 171-message story's key beats with every model tried (eval 2026-10-24).
 * Between them, «## Ключевые итоги» lists the lasting outcomes each chapter reported. Compression
 * never touches them; only the list itself is merged when it outgrows OUTCOMES_SHARE.
 */
export const SUMMARY_PROMPT = `Ты — суммаризатор ролевых диалогов. Сохрани смысл, действующие планы и изменения состояния по исходной переписке.`;
export const MERGE_PROMPT = `Ты — суммаризатор ролевых диалогов. Обнови краткую сводку по новой части переписки. Сохрани содержание открытых планов, объедини повторы; различай предложение, решение, выполнение и отмену. При неясном противоречии не угадывай.`;
const CHAPTER_PROMPT = `Ты — суммаризатор ролевых диалогов. Допиши следующую главу предыстории по новой части переписки и обнови текущую ситуацию, решения и планы. Различай предложение, решение, выполнение и отмену. При неясном противоречии не угадывай.`;
const COMPRESSION_PROMPT = `Ты — редактор предыстории ролевого диалога.`;
const OUTCOMES_PROMPT = `Ты — редактор ключевых итогов ролевого диалога.`;

export type SummaryMode = "summary" | "merge" | "chapter" | "compress" | "outcomes";
/** The new chapter and the current sections share half of the allowance; written chapters keep the rest. */
export const CHAPTER_BUDGET_SHARE = 0.5;
/** A compressed pair keeps ~60% of its length, and at most this share of the allowance. */
const COMPRESSED_SHARE = 0.6, COMPRESSED_MIN_SHARE = 0.35, COMPRESSED_MAX_SHARE = 0.35, MAX_COMPRESSIONS = 4;
/** After an overflow the summary is compressed to this share of its allowance. */
const COMPRESSED_TARGET_SHARE = 0.75;
/** A compression is kept when it is at most 85% of the pair, so every round frees room. */
const COMPRESSED_ACCEPT_SHARE = 0.85;
/** «## Предыстория» counted by the renderer's budget. */
const HEADING_TOKENS = 8;
/** The key outcomes may fill this share of the allowance; past it the list is merged by the model. */
const OUTCOMES_SHARE = 0.35;
/** Room a chapter answer gets for its new outcomes on top of the chapter budget. */
const OUTCOME_ANSWER_TOKENS = 200;

export function summarySystemPrompt(mode: SummaryMode, maxTokens: number, names: SummaryParticipants = {}): string {
  const cast = [names.user && `герой пользователя — ${names.user}`, names.character && `персонаж — ${names.character}`].filter(Boolean);
  const castLine = cast.length ? `\nУчастники: ${cast.join(", ")}. В пересказе называй их по именам, а не «пользователь» и «персонаж».` : "";
  if (mode === "outcomes") {
    return `${OUTCOMES_PROMPT}\n\n${OUTCOME_COMPRESSION_RULES}\nСписок должен поместиться в ${maxTokens} токенов.${castLine}`;
  }
  if (mode === "compress") {
    return `${COMPRESSION_PROMPT}\n\n${CHAPTER_COMPRESSION_RULES}\nГлава должна поместиться в ${maxTokens} токенов. Максимум ${summaryItemLimit(maxTokens)} пунктов, каждый — не длиннее ${SUMMARY_ITEM_MAX_CHARS} символов.${castLine}`;
  }
  const chapter = mode === "chapter";
  const prompt = chapter ? CHAPTER_PROMPT : mode === "merge" ? MERGE_PROMPT : SUMMARY_PROMPT;
  return prompt + "\n\n" + (chapter ? CHAPTER_SUMMARY_RULES : GROUNDED_SUMMARY_RULES)
    + `\nИтоговая сводка после удаления JSON-полей должна поместиться в ${maxTokens} токенов, включая заголовки и метки. Максимум ${summaryItemLimit(maxTokens)} пунктов${chapter ? "" : `, из них past — не больше ${pastItemLimit(maxTokens)}`}. Текст пунктов — не более ${Math.max(40, maxTokens - 80)} токенов суммарно. Каждый пункт — не длиннее ${SUMMARY_ITEM_MAX_CHARS} символов. Сжимай: одно-два коротких предложения на сцену; пропускай жесты, взгляды, обстановку и проходные реплики; сохраняй события, решения, изменения отношений и открытые линии; условия сделок, долгов и обещаний — с суммами, сроками и местами.${chapter ? "" : " Старые сцены при обновлении сжимай сильнее, чем новые."} JSON полностью закрой; без markdown-обёртки.`
    + castLine;
}

const STORY_HEADING = /^#{1,3}\s*Предыстория\s*$/u;
const OUTCOMES_LINE = new RegExp(`^#{1,3}\\s*${OUTCOMES_HEADING}\\s*$`, "u");
const sentences = (text: string) => text.split(/(?<=[.!?…])(?<!(?:^|[\s«"(])\p{Lu}\.)\s+/u).map(part => part.trim()).filter(Boolean);

/** Chapters are the lines under «## Предыстория», outcomes those under «## Ключевые итоги»; a summary
 * without headings is one legacy chapter. */
export function splitSummaryChapters(summary: string): { chapters: string[]; outcomes: string[]; rest: string } {
  const lines = summary.split(/\r?\n/);
  if (!lines.some(line => /^#{1,3}\s/.test(line.trim()))) {
    const text = lines.map(line => line.trim()).filter(Boolean).join(" ");
    return { chapters: text ? [text] : [], outcomes: [], rest: "" };
  }
  const chapters: string[] = [], outcomes: string[] = [], rest: string[] = [];
  let part: "story" | "outcomes" | "rest" = "rest";
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,3}\s/.test(trimmed)) {
      part = STORY_HEADING.test(trimmed) ? "story" : OUTCOMES_LINE.test(trimmed) ? "outcomes" : "rest";
      if (part === "rest") rest.push(line);
      continue;
    }
    if (part === "story") { if (trimmed) chapters.push(trimmed); }
    else if (part === "outcomes") { const text = trimmed.replace(/^[-*•]\s*/u, ""); if (text) outcomes.push(text); }
    else rest.push(line);
  }
  return { chapters, outcomes, rest: rest.join("\n").trim() };
}

export function composeChapterSummary(chapters: string[], rest: string, outcomes: string[] = []): string {
  return [chapters.length ? `## Предыстория\n${chapters.join("\n")}` : "",
    outcomes.length ? `## ${OUTCOMES_HEADING}\n${outcomes.map(line => `- ${line}`).join("\n")}` : "",
    rest.trim()].filter(Boolean).join("\n\n");
}

/** One answer of the summary model for `mode`, already read from the provider (readSummaryResponse). */
export type SummaryAsk = (mode: SummaryMode, input: string, maxTokens: number, sourceIds: string[]) => Promise<string>;
/** Counters only: never chapter text. */
export type ChapterStats = { chapterCount: number; newChapterCount: number; compressedPairCount: number;
  compressionFallbackCount: number; budgetTrimmedSentenceCount: number; outcomeCount: number; newOutcomeCount: number;
  outcomeMergeCount: number; outcomeDroppedCount: number };
/** maxTokens is the whole summary's allowance; chapterTokens (the plan's base allowance) sizes one new chapter, so a
 * grown allowance keeps more chapters without longer, slower chapter answers. */
type ChapterContext = { maxTokens: number; chapterTokens?: number; core: string | null; names: SummaryParticipants;
  countTokens: (text: string) => number; ask: SummaryAsk; diagnose?: (stats: SummaryRenderDiagnostics) => void };

/**
 * Writes the next chapter from `messages` and returns the whole new summary. The previous chapters
 * are context only; the previous current sections are sources, so open plans can carry over.
 * Throws MemorySummaryError when nothing of the answer is supported, like a merge did.
 */
export async function writeSummaryChapter(previous: string, messages: Array<{ role: string; content: string }>,
  context: ChapterContext, onStats?: (stats: ChapterStats) => void): Promise<string> {
  const { core, names, countTokens, ask, diagnose } = context;
  const base = Math.min(context.chapterTokens ?? context.maxTokens, context.maxTokens);
  const { chapters, outcomes, rest } = splitSummaryChapters(previous);
  const sources = [...sourcesFromSummaries(rest), ...makeSummarySources(messages)].map((source, index) => ({ ...source, id: `s${index + 1}` }));
  if (!sources.length) throw new MemorySummaryError("MEMORY_SUMMARY_NO_FITTING_SOURCE");
  const budget = Math.min(base, Math.max(Math.min(300, base), Math.floor(base * CHAPTER_BUDGET_SHARE)));
  // Only the latest chapter, for continuity: given all of them, Mistral re-told old scenes as the
  // new chapter, and words shared with the new messages let them pass (eval 2026-10-24).
  const latest = chapters.at(-1) ?? "";
  // The outcomes written so far are context too, so a chapter adds only new ones.
  const raw = await ask("chapter", JSON.stringify({ sources, core, previous: latest, outcomes }), budget, sources.map(source => source.id));
  // Names from earlier chapters may appear again; they are never evidence for an assertion.
  const rendered = renderGroundedSummary(raw, sources, budget, countTokens, diagnose, [core ?? "", ...chapters].join("\n"), names, "chapter",
    OUTCOME_ANSWER_TOKENS);
  if (!rendered) throw new MemorySummaryError("MEMORY_SUMMARY_NO_FITTING_SOURCE");
  const fresh = splitSummaryChapters(rendered);
  // A sentence already told in an earlier chapter is not told again.
  const told = chapters.flatMap(sentences);
  const chapter = fresh.chapters.flatMap(sentences).filter(sentence => !told.some(old => old === sentence || sameMemoryMeaning(old, sentence))).join(" ");
  const added = fresh.outcomes.filter(line => !outcomes.some(old => old === line || sameMemoryMeaning(old, line)));
  const stats: ChapterStats = { chapterCount: 0, newChapterCount: chapter ? 1 : 0, compressedPairCount: 0,
    compressionFallbackCount: 0, budgetTrimmedSentenceCount: 0, outcomeCount: 0, newOutcomeCount: added.length,
    outcomeMergeCount: 0, outcomeDroppedCount: 0 };
  const kept = await fitOutcomes([...outcomes, ...added], context, stats);
  const summary = await fitChapters([...chapters, ...(chapter ? [chapter] : [])], fresh.rest, kept, context, stats);
  const parts = splitSummaryChapters(summary);
  stats.chapterCount = parts.chapters.length; stats.outcomeCount = parts.outcomes.length;
  onStats?.(stats);
  return summary;
}

/** Keeps the outcomes within OUTCOMES_SHARE: the model merges the list once; a list still too long
 * (or a refused answer) loses its oldest lines after the first one, the story's opening. */
async function fitOutcomes(outcomes: string[], context: ChapterContext, stats: ChapterStats): Promise<string[]> {
  const { maxTokens, core, names, countTokens, ask, diagnose } = context;
  const limit = Math.floor(maxTokens * OUTCOMES_SHARE);
  const size = (lines: string[]) => countTokens(composeChapterSummary([], "", lines));
  if (size(outcomes) <= limit) return outcomes;
  let kept = outcomes;
  const sources = outcomes.map((text, index) => ({ id: `s${index + 1}`, author: "memory" as const, text }));
  try {
    const raw = await ask("outcomes", JSON.stringify({ sources }), Math.floor(limit * COMPRESSED_TARGET_SHARE), sources.map(source => source.id));
    const merged = splitSummaryChapters(renderGroundedSummary(raw, sources, 0, countTokens, diagnose, core ?? "", names, "chapter", limit)).outcomes;
    if (merged.length && size(merged) < size(outcomes)) { kept = merged; stats.outcomeMergeCount++; }
  } catch (error) {
    // A refused or unusable answer falls back below; a transport failure defers the whole refresh.
    if (!(error instanceof MemorySummaryError)) throw error;
  }
  while (size(kept) > limit && kept.length > 1) { kept = [kept[0], ...kept.slice(2)]; stats.outcomeDroppedCount++; }
  return kept;
}

async function fitChapters(chapters: string[], rest: string, outcomes: string[], context: ChapterContext, stats: ChapterStats): Promise<string> {
  const { maxTokens, countTokens } = context;
  const size = () => countTokens(composeChapterSummary(chapters, rest, outcomes));
  // The newest chapter is never touched by a compression: at least three chapters are needed.
  // Once over the allowance, compress down to COMPRESSED_TARGET_SHARE of it, so the next chapters fit
  // without another round: compressing just under the limit re-compressed the story's opening on
  // almost every refresh (prod test 2026-10-24).
  // One round per overflow: it aims at the 75% target, and only a summary still over its allowance
  // gets another. Looping to the target took two rounds per overflow, since the model writes the
  // pair longer than asked (prod test 2026-10-25).
  const target = size() > maxTokens ? Math.floor(maxTokens * COMPRESSED_TARGET_SHARE) : maxTokens;
  for (let round = 0; (round === 0 ? size() > target : size() > maxTokens) && chapters.length >= 3 && round < MAX_COMPRESSIONS; round++) {
    chapters = [await compressChapters(chapters[0], chapters[1], context, stats, size() - target), ...chapters.slice(2)];
  }
  // Last resort without a model: the oldest chapters lose their later sentences, their opening
  // stays; then the current sections lose their last lines.
  for (let index = 0; size() > maxTokens && index < chapters.length; ) {
    const parts = sentences(chapters[index]);
    if (parts.length > 1) { chapters[index] = parts.slice(0, -1).join(" "); stats.budgetTrimmedSentenceCount++; } else index++;
  }
  const restLines = rest.split("\n");
  while (size() > maxTokens && restLines.length) { restLines.pop(); rest = restLines.join("\n"); }
  return composeChapterSummary(chapters, rest, outcomes);
}

async function compressChapters(first: string, second: string, context: ChapterContext, stats: ChapterStats, excess = 0): Promise<string> {
  const { maxTokens, core, names, countTokens, ask, diagnose } = context;
  const pairTokens = countTokens(`${first} ${second}`);
  // Ask for what the overflow needs in one round, between 35% and 60% of the pair: compressing
  // each pair to 60% took 2–4 rounds per overflow, and every round re-told the story's opening
  // (16 rounds in 20 minutes on three stories, prod test 2026-10-24).
  const wanted = Math.min(Math.ceil(pairTokens * COMPRESSED_SHARE), Math.max(Math.ceil(pairTokens * COMPRESSED_MIN_SHARE), pairTokens - excess));
  const target = Math.max(Math.min(120, maxTokens), Math.min(wanted, Math.floor(maxTokens * COMPRESSED_MAX_SHARE)));
  const sources = sourcesFromSummaries(`## Предыстория\n${first}\n${second}`).map((source, index) => ({ ...source, id: `s${index + 1}` }));
  try {
    const raw = await ask("compress", JSON.stringify({ sources }), target, sources.map(source => source.id));
    // The target steers the model; any answer clearly shorter than the pair is kept. Fitting it to
    // the target dropped a 280-token compression of a 426-token pair whole (target 256), and the
    // fallback then cut the story's opening (prod rebuild 2026-10-24). A summary still too long gets
    // another round.
    const rendered = renderGroundedSummary(raw, sources, Math.ceil(pairTokens * COMPRESSED_ACCEPT_SHARE) + HEADING_TOKENS, countTokens,
      diagnose, [core ?? "", first, second].join("\n"), names, "chapter");
    const text = splitSummaryChapters(rendered).chapters.join(" ");
    if (text && countTokens(text) <= pairTokens * COMPRESSED_ACCEPT_SHARE) { stats.compressedPairCount++; return text; }
  } catch (error) {
    // A refused or unusable answer falls back below; a transport failure defers the whole refresh.
    if (!(error instanceof MemorySummaryError)) throw error;
  }
  stats.compressionFallbackCount++;
  return shortenPair(first, second, target, countTokens);
}

/** Opening sentences of both chapters, taken in turn, in chronological order; the first one always stays. */
function shortenPair(first: string, second: string, limit: number, countTokens: (text: string) => number): string {
  const lists = [sentences(first), sentences(second)], kept: string[][] = [[], []];
  const text = () => [...kept[0], ...kept[1]].join(" ");
  for (let index = 0; index < Math.max(lists[0].length, lists[1].length); index++) {
    for (const side of [0, 1]) {
      if (index >= lists[side].length) continue;
      kept[side].push(lists[side][index]);
      if (countTokens(text()) > limit && text() !== lists[0][0]) { kept[side].pop(); return text(); }
    }
  }
  return text();
}
