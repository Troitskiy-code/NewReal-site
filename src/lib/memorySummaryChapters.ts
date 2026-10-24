import { CHAPTER_COMPRESSION_RULES, CHAPTER_SUMMARY_RULES, GROUNDED_SUMMARY_RULES, makeSummarySources, renderGroundedSummary,
  sourcesFromSummaries, type SummaryParticipants, type SummaryRenderDiagnostics } from "./memorySummaryEvidence";
import { MemorySummaryError, pastItemLimit, SUMMARY_ITEM_MAX_CHARS, summaryItemLimit } from "./memorySummaryPolicy";
import { sameMemoryMeaning } from "./memoryNarrative";

/**
 * A long story's summary is a list of chapters under «## Предыстория», one line each, followed by
 * the current sections (situation, decisions, plans). A chapter is written once from its own
 * messages and never re-told; only when the summary outgrows its allowance are the two oldest
 * chapters compressed into one. Re-telling the whole past on every merge kept ~30% of a
 * 171-message story's key beats with every model tried (eval 2026-10-24).
 */
export const SUMMARY_PROMPT = `Ты — суммаризатор ролевых диалогов. Сохрани смысл, действующие планы и изменения состояния по исходной переписке.`;
export const MERGE_PROMPT = `Ты — суммаризатор ролевых диалогов. Обнови краткую сводку по новой части переписки. Сохрани содержание открытых планов, объедини повторы; различай предложение, решение, выполнение и отмену. При неясном противоречии не угадывай.`;
const CHAPTER_PROMPT = `Ты — суммаризатор ролевых диалогов. Допиши следующую главу предыстории по новой части переписки и обнови текущую ситуацию, решения и планы. Различай предложение, решение, выполнение и отмену. При неясном противоречии не угадывай.`;
const COMPRESSION_PROMPT = `Ты — редактор предыстории ролевого диалога.`;

export type SummaryMode = "summary" | "merge" | "chapter" | "compress";
/** The new chapter and the current sections share half of the allowance; written chapters keep the rest. */
export const CHAPTER_BUDGET_SHARE = 0.5;
/** A compressed pair keeps ~60% of its length, and at most this share of the allowance. */
const COMPRESSED_SHARE = 0.6, COMPRESSED_MAX_SHARE = 0.35, MAX_COMPRESSIONS = 4;

export function summarySystemPrompt(mode: SummaryMode, maxTokens: number, names: SummaryParticipants = {}): string {
  const cast = [names.user && `герой пользователя — ${names.user}`, names.character && `персонаж — ${names.character}`].filter(Boolean);
  const castLine = cast.length ? `\nУчастники: ${cast.join(", ")}. В пересказе называй их по именам, а не «пользователь» и «персонаж».` : "";
  if (mode === "compress") {
    return `${COMPRESSION_PROMPT}\n\n${CHAPTER_COMPRESSION_RULES}\nГлава должна поместиться в ${maxTokens} токенов. Максимум ${summaryItemLimit(maxTokens)} пунктов, каждый — не длиннее ${SUMMARY_ITEM_MAX_CHARS} символов.${castLine}`;
  }
  const chapter = mode === "chapter";
  const prompt = chapter ? CHAPTER_PROMPT : mode === "merge" ? MERGE_PROMPT : SUMMARY_PROMPT;
  return prompt + "\n\n" + (chapter ? CHAPTER_SUMMARY_RULES : GROUNDED_SUMMARY_RULES)
    + `\nИтоговая сводка после удаления JSON-полей должна поместиться в ${maxTokens} токенов, включая заголовки и метки. Максимум ${summaryItemLimit(maxTokens)} пунктов${chapter ? "" : `, из них past — не больше ${pastItemLimit(maxTokens)}`}. Текст пунктов — не более ${Math.max(40, maxTokens - 80)} токенов суммарно. Каждый пункт — не длиннее ${SUMMARY_ITEM_MAX_CHARS} символов. Сжимай: одно-два коротких предложения на сцену; пропускай жесты, взгляды, обстановку и проходные реплики; сохраняй события, решения, изменения отношений и открытые линии.${chapter ? "" : " Старые сцены при обновлении сжимай сильнее, чем новые."} JSON полностью закрой; без markdown-обёртки.`
    + castLine;
}

const STORY_HEADING = /^#{1,3}\s*Предыстория\s*$/u;
const sentences = (text: string) => text.split(/(?<=[.!?…])\s+/u).map(part => part.trim()).filter(Boolean);

/** Chapters are the lines under «## Предыстория»; a summary without headings is one legacy chapter. */
export function splitSummaryChapters(summary: string): { chapters: string[]; rest: string } {
  const lines = summary.split(/\r?\n/);
  if (!lines.some(line => /^#{1,3}\s/.test(line.trim()))) {
    const text = lines.map(line => line.trim()).filter(Boolean).join(" ");
    return { chapters: text ? [text] : [], rest: "" };
  }
  const chapters: string[] = [], rest: string[] = [];
  let inStory = false;
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line.trim())) { inStory = STORY_HEADING.test(line.trim()); if (!inStory) rest.push(line); continue; }
    if (inStory) { if (line.trim()) chapters.push(line.trim()); } else rest.push(line);
  }
  return { chapters, rest: rest.join("\n").trim() };
}

export function composeChapterSummary(chapters: string[], rest: string): string {
  return [chapters.length ? `## Предыстория\n${chapters.join("\n")}` : "", rest.trim()].filter(Boolean).join("\n\n");
}

/** One answer of the summary model for `mode`, already read from the provider (readSummaryResponse). */
export type SummaryAsk = (mode: SummaryMode, input: string, maxTokens: number, sourceIds: string[]) => Promise<string>;
/** Counters only: never chapter text. */
export type ChapterStats = { chapterCount: number; newChapterCount: number; compressedPairCount: number;
  compressionFallbackCount: number; budgetTrimmedSentenceCount: number };
type ChapterContext = { maxTokens: number; core: string | null; names: SummaryParticipants;
  countTokens: (text: string) => number; ask: SummaryAsk; diagnose?: (stats: SummaryRenderDiagnostics) => void };

/**
 * Writes the next chapter from `messages` and returns the whole new summary. The previous chapters
 * are context only; the previous current sections are sources, so open plans can carry over.
 * Throws MemorySummaryError when nothing of the answer is supported, like a merge did.
 */
export async function writeSummaryChapter(previous: string, messages: Array<{ role: string; content: string }>,
  context: ChapterContext, onStats?: (stats: ChapterStats) => void): Promise<string> {
  const { maxTokens, core, names, countTokens, ask, diagnose } = context;
  const { chapters, rest } = splitSummaryChapters(previous);
  const sources = [...sourcesFromSummaries(rest), ...makeSummarySources(messages)].map((source, index) => ({ ...source, id: `s${index + 1}` }));
  if (!sources.length) throw new MemorySummaryError("MEMORY_SUMMARY_NO_FITTING_SOURCE");
  const budget = Math.min(maxTokens, Math.max(Math.min(300, maxTokens), Math.floor(maxTokens * CHAPTER_BUDGET_SHARE)));
  // Only the latest chapter, for continuity: given all of them, Mistral re-told old scenes as the
  // new chapter, and words shared with the new messages let them pass (eval 2026-10-24).
  const latest = chapters.at(-1) ?? "";
  const raw = await ask("chapter", JSON.stringify({ sources, core, previous: latest }), budget, sources.map(source => source.id));
  // Names from earlier chapters may appear again; they are never evidence for an assertion.
  const rendered = renderGroundedSummary(raw, sources, budget, countTokens, diagnose, [core ?? "", ...chapters].join("\n"), names, "chapter");
  if (!rendered) throw new MemorySummaryError("MEMORY_SUMMARY_NO_FITTING_SOURCE");
  const fresh = splitSummaryChapters(rendered);
  // A sentence already told in an earlier chapter is not told again.
  const told = chapters.flatMap(sentences);
  const chapter = fresh.chapters.flatMap(sentences).filter(sentence => !told.some(old => old === sentence || sameMemoryMeaning(old, sentence))).join(" ");
  const stats: ChapterStats = { chapterCount: 0, newChapterCount: chapter ? 1 : 0, compressedPairCount: 0,
    compressionFallbackCount: 0, budgetTrimmedSentenceCount: 0 };
  const summary = await fitChapters([...chapters, ...(chapter ? [chapter] : [])], fresh.rest, context, stats);
  stats.chapterCount = splitSummaryChapters(summary).chapters.length;
  onStats?.(stats);
  return summary;
}

async function fitChapters(chapters: string[], rest: string, context: ChapterContext, stats: ChapterStats): Promise<string> {
  const { maxTokens, countTokens } = context;
  const size = () => countTokens(composeChapterSummary(chapters, rest));
  // The newest chapter is never touched by a compression: at least three chapters are needed.
  for (let round = 0; size() > maxTokens && chapters.length >= 3 && round < MAX_COMPRESSIONS; round++) {
    chapters = [await compressChapters(chapters[0], chapters[1], context, stats), ...chapters.slice(2)];
  }
  // Last resort without a model: the oldest chapters lose their later sentences, their opening
  // stays; then the current sections lose their last lines.
  for (let index = 0; size() > maxTokens && index < chapters.length; ) {
    const parts = sentences(chapters[index]);
    if (parts.length > 1) { chapters[index] = parts.slice(0, -1).join(" "); stats.budgetTrimmedSentenceCount++; } else index++;
  }
  const restLines = rest.split("\n");
  while (size() > maxTokens && restLines.length) { restLines.pop(); rest = restLines.join("\n"); }
  return composeChapterSummary(chapters, rest);
}

async function compressChapters(first: string, second: string, context: ChapterContext, stats: ChapterStats): Promise<string> {
  const { maxTokens, core, names, countTokens, ask } = context;
  const target = Math.max(Math.min(120, maxTokens),
    Math.min(Math.ceil(countTokens(`${first} ${second}`) * COMPRESSED_SHARE), Math.floor(maxTokens * COMPRESSED_MAX_SHARE)));
  const sources = sourcesFromSummaries(`## Предыстория\n${first}\n${second}`).map((source, index) => ({ ...source, id: `s${index + 1}` }));
  try {
    const raw = await ask("compress", JSON.stringify({ sources }), target, sources.map(source => source.id));
    const rendered = renderGroundedSummary(raw, sources, target, countTokens, undefined, [core ?? "", first, second].join("\n"), names, "chapter");
    const text = splitSummaryChapters(rendered).chapters.join(" ");
    if (text && countTokens(text) < countTokens(`${first} ${second}`)) { stats.compressedPairCount++; return text; }
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
