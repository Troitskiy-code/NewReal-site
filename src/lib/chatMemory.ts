import { serviceChatPost as meteredPost } from "@/lib/aiTextClient";
import { countTokens } from "@/lib/tokenCount";
import { prisma } from "@/lib/prisma";
import { getContextTokenLimit } from "@/lib/chatEconomy";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";
import { ensureMemoryHierarchyColumns } from "@/lib/ensureMemoryHierarchyColumns";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { sanitizeCoreMemory } from "@/lib/coreMemorySanitize";
import { makeSummarySources, participantNames, renderGroundedSummary, sourcesFromSummaries, type SummaryParticipants, type SummarySource } from "@/lib/memorySummaryEvidence";
import { summarySystemPrompt, writeSummaryChapter, type SummaryMode } from "@/lib/memorySummaryChapters";
import { KieTextError, kieSummaryEnabled, requestKieSummary } from "@/lib/kieText";
import { getSelectedChatPersona } from "@/lib/personaService";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { memoryScopeWhere, messageScopeWhere, type ChatScope } from "@/lib/chatThreads";
import { getMemoryProvider } from "./aiProviders";
import { groundedSummaryFormat, isDeferredSummaryFailure, MemorySummaryError, readSummaryResponse, summaryGenerationLimit } from "./memorySummaryPolicy";
import { SUMMARY_SIZE_LIMIT_COOLDOWN_SECONDS, withSummaryRefreshLease } from "./memorySummaryRefresh";
import { memoryV2Enabled } from "./memoryFacts";
import { lockMemoryThread } from "./memoryV2";
import {
  fetchEmbeddings,
  hasDistinctKeyTokens,
  keepUniqueByCosine,
  logSimilarityMatrix,
  SEMANTIC_DEDUP_THRESHOLD,
} from "@/lib/memoryEmbeddings";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const SUMMARY_MODEL = "openai/gpt-4o-mini";
/** A grounded summary of a long story is ~1200 output tokens: ~30 s on Mistral-Small through the
 * proxy, so the default 30 s service timeout cut most rebuild steps (prod 2026-10-24). Summaries
 * run in the background or in the explicit rebuild, never on the reply path; the lease is 180 s. */
const SUMMARY_TIMEOUT_MS = 90_000;
const KEEP_RECENT_MESSAGES = 25;
/** One summary call never takes more than this many messages; older backlogs catch up oldest-first. */
export const MAX_SUMMARY_CHUNK_MESSAGES = 120;
const WORD_OVERLAP_DUPLICATE_RATIO = 0.8;

export type SubscriptionType = "start" | "dialog" | "story" | "universe" | null | undefined;

export type SummaryConfig = {
  maxTokens: number;
  thresholdRatio: number;
  refreshMessageThreshold: number;
  refreshTokenThreshold: number;
};

export const SUMMARY_CONFIG: Record<string, SummaryConfig> = {
  start: {
    maxTokens: 200,
    thresholdRatio: 0.5,
    refreshMessageThreshold: 15,
    refreshTokenThreshold: 1500,
  },
  dialog: {
    maxTokens: 500,
    thresholdRatio: 0.5,
    refreshMessageThreshold: 20,
    refreshTokenThreshold: 2000,
  },
  story: {
    maxTokens: 800,
    thresholdRatio: 0.6,
    refreshMessageThreshold: 30,
    refreshTokenThreshold: 2500,
  },
  universe: {
    maxTokens: 1500,
    thresholdRatio: 0.7,
    refreshMessageThreshold: 40,
    refreshTokenThreshold: 3000,
  },
};

export function getSummaryConfig(subscriptionType: string | null | undefined): SummaryConfig {
  const normalized = subscriptionType === "history" ? "story" : subscriptionType;
  if (!normalized || normalized === "start") return SUMMARY_CONFIG.start;
  return SUMMARY_CONFIG[normalized] ?? SUMMARY_CONFIG.dialog;
}

function getSummaryConfigForUser(user: {
  subscriptionType?: string | null;
  subscriptionEnd?: Date | string | null;
}): { config: SummaryConfig; plan: string } {
  const end =
    user.subscriptionEnd instanceof Date
      ? user.subscriptionEnd
      : user.subscriptionEnd
        ? new Date(user.subscriptionEnd)
        : null;
  const active = isSubscriptionActive({
    subscriptionType: user.subscriptionType ?? null,
    subscriptionEnd: end,
  });
  const plan = active ? user.subscriptionType ?? "dialog" : "start";
  return { config: getSummaryConfig(plan), plan: plan === "history" ? "story" : plan || "start" };
}

const MAX_SUMMARY_INPUT_TOKENS = 12_000;
function summaryInputTooLarge(input: string, tokenLimit = MAX_SUMMARY_INPUT_TOKENS): boolean {
  // Bound work before the tokenizer too: adversarial repeated text can make BPE expensive.
  return input.length > tokenLimit * 8 || countTokens(input) > tokenLimit;
}

type DialogMessage = {
  role: string;
  content: string;
  createdAt?: Date | string;
};

type SummarySections = {
  story?: string;
  state?: string;
  decisions?: string;
  permanent?: string;
  activeLines?: string;
  events?: string;
  emotion?: string;
};

const HEADING_MAP: Array<{ key: keyof SummarySections; test: RegExp }> = [
  { key: "story", test: /^#{1,3}\s*(предыстория|backstory)/i },
  { key: "state", test: /^#{1,3}\s*(текущая ситуация|current situation)/i },
  { key: "decisions", test: /^#{1,3}\s*(принятые решения|decisions)/i },
  { key: "activeLines", test: /^#{1,3}\s*(открытые планы|open plans)/i },
  { key: "permanent", test: /^#{1,3}\s*(постоянн|permanent)/i },
  { key: "activeLines", test: /^#{1,3}\s*(активн|active\s+lines?)/i },
  { key: "events", test: /^#{1,3}\s*(недавн|recent\s+events?|событи|events)/i },
  { key: "emotion", test: /^#{1,3}\s*(эмоциональн|emotional)/i },
];

function headingKey(line: string): keyof SummarySections | null {
  const trimmed = line.trim();
  for (const entry of HEADING_MAP) {
    if (entry.test.test(trimmed)) return entry.key;
  }
  return null;
}

function extractListItems(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*•]/.test(line) || /^\d+[.)]/.test(line))
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean);
}

export function parseSummarySections(text: string): SummarySections {
  const sections: SummarySections = {};
  const lines = text.split(/\r?\n/);
  let current: keyof SummarySections | null = null;
  const buckets: Record<keyof SummarySections, string[]> = {
    story: [],
    state: [],
    decisions: [],
    permanent: [],
    activeLines: [],
    events: [],
    emotion: [],
  };

  for (const line of lines) {
    const key = headingKey(line);
    if (key) {
      current = key;
      continue;
    }
    if (current) {
      buckets[current].push(line);
    }
  }

  for (const key of Object.keys(buckets) as Array<keyof SummarySections>) {
    const body = buckets[key].join("\n").trim();
    if (body) sections[key] = body;
  }

  if (!Object.values(sections).some(Boolean)) {
    const items = extractListItems(text);
    if (items.length > 0) {
      sections.events = items.map((item, index) => `${index + 1}. ${item}`).join("\n");
    }
  }

  return sections;
}

export function rebuildSummary(sections: SummarySections): string {
  const parts: string[] = [];
  if (sections.story?.trim()) parts.push(`## Предыстория\n${sections.story.trim()}`);
  if (sections.state?.trim()) parts.push(`## Текущая ситуация\n${sections.state.trim()}`);
  if (sections.decisions?.trim()) parts.push(`## Принятые решения\n${sections.decisions.trim()}`);
  if (sections.permanent?.trim()) {
    parts.push(`## Постоянное\n${sections.permanent.trim()}`);
  }
  if (sections.activeLines?.trim()) {
    parts.push(`## Активные линии\n${sections.activeLines.trim()}`);
  }
  if (sections.events?.trim()) {
    parts.push(`## Недавние события\n${sections.events.trim()}`);
  }
  if (sections.emotion?.trim()) {
    parts.push(`## Эмоциональный фон\n${sections.emotion.trim()}`);
  }
  return parts.join("\n\n").trim();
}

/**
 * Offline fallback when embeddings are unavailable. Word overlap cannot tell a paraphrase
 * from a changed fact, so only near-identical lines with the same names/numbers are merged.
 */
export function deduplicateLines(lines: string[]): string[] {
  const result: string[] = [];
  const normalize = (line: string) => line.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
  const significantWords = (line: string) => normalize(line).split(" ").filter((word) => word.length > 4);

  for (const line of lines) {
    const words = significantWords(line);
    const isDuplicate = result.some((existing) => {
      if (normalize(existing) === normalize(line)) return true;
      if (hasDistinctKeyTokens(line, existing)) return false;
      const existingWords = significantWords(existing);
      const overlap = words.filter((word) => existingWords.includes(word)).length;
      const longest = Math.max(words.length, existingWords.length);
      return longest > 0 && overlap / longest >= WORD_OVERLAP_DUPLICATE_RATIO;
    });
    if (!isDuplicate) result.push(line);
  }

  return result;
}

export async function deduplicateLinesSemantic(
  lines: string[],
  apiKey: string
): Promise<string[]> {
  if (lines.length < 2) return lines;

  try {
    const embeddings = await fetchEmbeddings(lines, apiKey);
    logSimilarityMatrix(embeddings, SEMANTIC_DEDUP_THRESHOLD);
    const result = keepUniqueByCosine(lines, embeddings, SEMANTIC_DEDUP_THRESHOLD);

    infoLog(
      "Memory:Dedup",
      `Semantic dedup: ${lines.length} → ${result.length} lines (similarity threshold ${SEMANTIC_DEDUP_THRESHOLD})`
    );
    return result;
  } catch {
    infoLog("Memory:Dedup", "Semantic embeddings unavailable, falling back to word overlap");
    return deduplicateLines(lines);
  }
}

const CONSOLIDATION_PROMPT = `Ты — редактор ролевых диалогов. Тебе дан список активных сюжетных линий. Объедини близкие по смыслу в МАКСИМУМ 5.

ЖЁСТКИЕ ТРЕБОВАНИЯ:
- Каждая итоговая линия — МАКСИМУМ 15 слов.
- НЕ используй союзы «в то время как», «при этом», «рассматривая», «демонстрируя» для склейки. Это не консолидация, а соединение.
- Если две линии описывают одну суть — сформулируй ОДНУ ОБЩУЮ фразу.
- Убирай повторы слов: если «вызов» встречается в 3 линиях — оставь один раз.

ПРИМЕРЫ:

Плохо (склейка):
- «Лукас пытается понять, интересна ли Рокс, в то время как Рокс выясняет готовность Лукаса открыться»

Хорошо (обобщение):
- «Лукас и Рокс взаимно изучают друг друга»

Плохо (соединение):
- «Оба испытывают влечение и продолжают игру вызова, рассматривая друг друга как объекты интереса и вызов»

Хорошо (обобщение):
- «Рокс и Лукас флиртуют, играя в игру вызова»

Формат ответа — только список, без вступлений:
- Линия 1
- Линия 2
...

Входные линии:
{{lines}}`;

function countLineWords(line: string): number {
  return line
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function averageLineWords(lines: string[]): number {
  if (lines.length === 0) return 0;
  const total = lines.reduce((sum, line) => sum + countLineWords(line), 0);
  return Math.round(total / lines.length);
}

function parseConsolidatedItems(text: string, maxLines: number): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, maxLines);
}

export async function consolidateActiveLines(
  lines: string[],
  apiKey: string,
  maxLines = 5
): Promise<string[]> {
  if (lines.length <= maxLines) return lines;

  try {
    const userContent = CONSOLIDATION_PROMPT.replace(
      "{{lines}}",
      lines.map((line) => `- ${line}`).join("\n")
    );

    const response = await meteredPost("summary",
      `${KODIKROUTER_URL}/chat/completions`,
      {
        model: SUMMARY_MODEL,
        messages: [
          { role: "system", content: "Ты — редактор." },
          { role: "user", content: userContent },
        ],
        max_tokens: 300,
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const text = response.data?.choices?.[0]?.message?.content?.trim() || "";
    const parsed = parseConsolidatedItems(text, maxLines);
    const result = parsed.length > 0 ? parsed : lines.slice(0, maxLines);
    const avgLength = averageLineWords(result);

    infoLog(
      "Memory:Consolidate",
      `${lines.length} → ${result.length} lines (avg length: ${avgLength} words)`
    );
    if (avgLength > 18) {
      infoLog("Memory:Consolidate", "WARNING: lines too long");
    }
    return result;
  } catch (error) {
    errorLog("Memory:Consolidate", "Failed:", toSafeDiagnostic(error));
    return lines.slice(0, maxLines);
  }
}

function eventsLimitForTokens(maxTokens: number): number {
  if (maxTokens < 600) return 4;
  if (maxTokens < 1000) return 6;
  return 8;
}

export async function postProcessSummary(
  rawSummary: string,
  maxTokens: number,
  apiKey: string
): Promise<string> {
  const sections = parseSummarySections(rawSummary);

  if (sections.activeLines) {
    const lines = extractListItems(sections.activeLines);
    const before = lines.length;
    const deduped = await deduplicateLinesSemantic(lines, apiKey);
    const consolidated =
      deduped.length > 5 ? await consolidateActiveLines(deduped, apiKey, 5) : deduped;
    const limited = consolidated.slice(0, 5);
    infoLog(
      "Memory:PostProcess",
      `Active lines: ${before} → ${limited.length} (dedupe: ${before - deduped.length}, consolidate: ${deduped.length - limited.length})`
    );
    sections.activeLines = limited.length > 0 ? limited.map((line) => `- ${line}`).join("\n") : undefined;
  }

  if (sections.events) {
    const events = extractListItems(sections.events);
    const before = events.length;
    const dedupedEvents = await deduplicateLinesSemantic(events, apiKey);
    const limit = eventsLimitForTokens(maxTokens);
    const limited = dedupedEvents.slice(-limit);
    infoLog(
      "Memory:PostProcess",
      `Events: ${before} → ${limited.length} (dedupe: ${before - dedupedEvents.length}, limit: ${dedupedEvents.length - limited.length})`
    );
    sections.events =
      limited.length > 0 ? limited.map((event, index) => `${index + 1}. ${event}`).join("\n") : undefined;
  }

  return rebuildSummary(sections);
}

function getRecentEventsLimit(arcTokens: number, maxTokens: number): number {
  if (maxTokens <= 0) return 8;
  const arcRatio = arcTokens / maxTokens;
  if (arcRatio > 0.8) return 3;
  if (arcRatio > 0.5) return 5;
  return 8;
}

function countActiveLines(summary: string): number {
  const match = summary.match(/##\s*Активные линии\s*([\s\S]*?)(?=\n##\s|$)/i);
  if (!match) return 0;
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter((line) => line.length > 0).length;
}

function formatDialogForSummary(messages: DialogMessage[]): string {
  return messages
    .map((message) => {
      const speaker = message.role === "user" ? "Пользователь" : "Персонаж";
      const time = message.createdAt
        ? new Date(message.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
        : "";
      return `[${time}] ${speaker}: ${message.content}`;
    })
    .join("\n\n");
}

function messageTime(message: DialogMessage): number {
  return message.createdAt ? new Date(message.createdAt).getTime() : Number.NaN;
}

/**
 * Oldest-first chunk to summarize, keeping the newest `keepRecent` messages out.
 * The boundary never splits messages with the same timestamp: coverage is stored as the
 * last summarized createdAt and later reads use `createdAt > coverage`.
 */
export function takeSummaryChunk(
  messages: DialogMessage[],
  keepRecent = KEEP_RECENT_MESSAGES,
  maxChunk = MAX_SUMMARY_CHUNK_MESSAGES
): DialogMessage[] {
  let end = Math.min(messages.length - keepRecent, maxChunk);
  if (end <= 0) return [];
  while (end > 0 && end < messages.length && messageTime(messages[end - 1]) === messageTime(messages[end])) {
    end -= 1;
  }
  return messages.slice(0, end);
}

/**
 * The newest messages stay out of the summary only while they fit the prompt: at most
 * RECENT_WINDOW_SHARE of the context, 4–25 messages. A fixed 25 long roleplay replies took
 * 12–15k of a 16k prompt; the oldest of them were neither summarized nor sent (up to 17 per
 * turn, prod test 2026-10-24).
 */
const RECENT_WINDOW_SHARE = 0.2, MIN_RECENT_MESSAGES = 4;
/** A refresh waits for this share of the context beyond the window, so a chapter retells a real
 * part of the story: at 3000 tokens long replies wrote a chapter every 2–3 turns and the oldest
 * chapter was re-compressed on almost every refresh. Window + backlog stay within ~half the context. */
const REFRESH_CONTEXT_SHARE = 0.3;
export function recentWindowSize(messages: DialogMessage[], contextTokens: number): number {
  const limit = Math.floor(contextTokens * RECENT_WINDOW_SHARE);
  let count = 0, tokens = 0;
  for (let index = messages.length - 1; index >= 0 && count < KEEP_RECENT_MESSAGES; index--) {
    const size = countTokens(messages[index].content);
    if (count >= MIN_RECENT_MESSAGES && tokens + size > limit) break;
    tokens += size; count++;
  }
  return count;
}
function getHistoryForSummary(messages: DialogMessage[], contextTokens: number): DialogMessage[] {
  return takeSummaryChunk(messages, recentWindowSize(messages, contextTokens));
}
export function refreshTokenThreshold(config: SummaryConfig, contextTokens: number): number {
  return Math.max(config.refreshTokenThreshold, Math.floor(contextTokens * REFRESH_CONTEXT_SHARE));
}

async function loadCoreMemoryText(scope: ChatScope): Promise<string | null> {
  const row = await prisma.coreMemory.findUnique({
    where: { threadId: scope.threadId },
    select: { content: true },
  });
  if (!row?.content?.trim()) return null;
  return sanitizeCoreMemory(row.content, { log: false }) || null;
}

function lastSummarizedTimestamp(messages: DialogMessage[]): Date {
  const last = messages[messages.length - 1];
  if (!last?.createdAt) return new Date();
  return last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt);
}

async function requestKodikText(
  apiKey: string,
  mode: SummaryMode,
  userContent: string,
  maxTokens: number,
  sourceIds: string[],
  names: SummaryParticipants = {}
): Promise<string> {
  const generationLimit = summaryGenerationLimit(maxTokens);
  const system = summarySystemPrompt(mode, maxTokens, names);
  if (kieSummaryEnabled()) {
    try {
      const data = await requestKieSummary(system, userContent, generationLimit, groundedSummaryFormat(sourceIds, maxTokens));
      const result = readSummaryResponse(data);
      infoLog("MemorySummary", "generation completed", { provider: "kie", finishReason: result.finishReason, generationLimit,
        storedLimit: maxTokens, outputUsage: data.usage.completion_tokens });
      return result.text;
    } catch (error) {
      // An answer cut at the limit goes through the chunk backoff like any provider's. A Kie that does
      // not answer (timeout, gateway or rate error, empty or refused answer) hands the call to DeepInfra.
      if (error instanceof MemorySummaryError && error.code !== "MEMORY_SUMMARY_EMPTY_RESPONSE") throw error;
      infoLog("MemorySummary", "kie unavailable, using reserve", { ...toSafeDiagnostic(error), stage: "kie_fallback",
        ...(error instanceof KieTextError ? { reason: error.reason } : {}) });
    }
  }
  const response = await meteredPost("summary",
    `${KODIKROUTER_URL}/chat/completions`,
    {
      model: SUMMARY_MODEL,
      messages: [
        {
          role: "system",
          content: system,
        },
        { role: "user", content: userContent },
      ],
      max_tokens: generationLimit,
      response_format: getMemoryProvider() === "deepinfra"
        ? groundedSummaryFormat(sourceIds, maxTokens) : { type: "json_object" },
      temperature: 0,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: SUMMARY_TIMEOUT_MS,
    }
  );

  try {
    const result = readSummaryResponse(response.data);
    infoLog("MemorySummary", "generation completed", { provider: getMemoryProvider(), finishReason: result.finishReason, generationLimit,
      storedLimit: maxTokens, outputUsage: Number(response.data?.usage?.completion_tokens) || 0 });
    return result.text;
  } catch (error) {
    errorLog("MemorySummary", "generation rejected", { ...toSafeDiagnostic(error), stage: "generation", generationLimit, storedLimit: maxTokens });
    throw error;
  }
}

async function requestSelectedSummary(
  apiKey: string, mode: SummaryMode, sources: SummarySource[], maxTokens: number,
  coreText: string | null, names: SummaryParticipants = {}
): Promise<string> {
  if (!sources.length) throw new MemorySummaryError("MEMORY_SUMMARY_NO_FITTING_SOURCE");
  // One bounded generation; failures are deferred by the background refresh lease.
  const input = JSON.stringify({ sources, core: coreText });
  if (summaryInputTooLarge(input)) throw new MemorySummaryInputError();
  const raw = await requestKodikText(apiKey, mode,
    input, maxTokens, sources.map(source => source.id), names);
  const summary = renderGroundedSummary(raw, sources, maxTokens, countTokens,
    stats => infoLog("MemorySummary", "render completed", stats), coreText ?? "", names);
  if (!summary) throw new MemorySummaryError("MEMORY_SUMMARY_NO_FITTING_SOURCE");
  return summary;
}

async function requestSummary(apiKey: string, messages: DialogMessage[], maxTokens: number, coreText: string | null,
  names: SummaryParticipants = {}): Promise<string> {
  return requestSelectedSummary(apiKey, "summary", makeSummarySources(messages), maxTokens, coreText, names);
}

/** The next chapter of `previous` from `messages`: written chapters are context and never re-told. */
async function requestChapterSummary(apiKey: string, previous: string, messages: DialogMessage[], maxTokens: number,
  coreText: string | null, names: SummaryParticipants = {}): Promise<string> {
  return writeSummaryChapter(previous, messages, { maxTokens, core: coreText, names, countTokens,
    ask: async (mode, input, budget, sourceIds) => {
      if (summaryInputTooLarge(input)) throw new MemorySummaryInputError();
      return requestKodikText(apiKey, mode, input, budget, sourceIds, names);
    },
    diagnose: stats => infoLog("MemorySummary", "render completed", stats) },
  stats => infoLog("MemorySummary", "chapters composed", stats));
}

const BACKOFF_FAILURES = new Set(["MEMORY_SUMMARY_TRUNCATED", "MEMORY_SUMMARY_NO_FITTING_SOURCE"]);
/** Older messages first, never splitting a timestamp group; the whole chunk if it cannot shrink. */
function olderHalf(messages: DialogMessage[]): DialogMessage[] {
  let end = Math.ceil(messages.length / 2);
  while (end > 0 && end < messages.length && messageTime(messages[end - 1]) === messageTime(messages[end])) end -= 1;
  return messages.slice(0, end);
}
/**
 * At temperature 0 one chunk can fail the same way on every attempt: an answer that runs past the
 * output limit with no complete item, or one where nothing passes the check. The refresh or rebuild
 * then stalled for good (prod 2026-10-24, step 147 of 196). The older half is retried; when it cannot
 * shrink further the chunk is skipped (`summary: null`): the caller keeps its retelling and moves on.
 */
async function summarizeChunk(messages: DialogMessage[], run: (chunk: DialogMessage[]) => Promise<string>):
  Promise<{ summary: string | null; used: DialogMessage[] }> {
  let chunk = messages;
  for (;;) {
    try {
      return { summary: await run(chunk), used: chunk };
    } catch (error) {
      if (!(error instanceof MemorySummaryError) || !BACKOFF_FAILURES.has(error.code)) throw error;
      const half = olderHalf(chunk);
      if (half.length && half.length < chunk.length) { chunk = half; continue; }
      infoLog("MemorySummary", "chunk skipped", { ...toSafeDiagnostic(error), stage: "chunk_backoff", count: chunk.length });
      return { summary: null, used: chunk };
    }
  }
}

/** Names for the retelling: Core first, then the story's persona and the character card.
 * Without them the model wrote «пользователь» throughout a 196-message story (prod 2026-10-24). */
async function summaryParticipants(scope: ChatScope, coreText: string | null): Promise<SummaryParticipants> {
  const fromCore = participantNames(coreText ?? "");
  const [character, persona] = await Promise.all([
    fromCore.character ? null : prisma.character.findUnique({ where: { id: scope.characterId }, select: { name: true } }),
    fromCore.user ? null : getSelectedChatPersona(scope.userId, scope.characterId, scope.threadId).catch(() => null),
  ]);
  const short = (name?: string | null) => name && name.trim().length <= 30 ? name.trim() : undefined;
  return { user: short(fromCore.user ?? persona?.name), character: short(fromCore.character ?? character?.name) };
}

function mergeSources(oldSummary: string, messages: DialogMessage[]): SummarySource[] {
  return [...sourcesFromSummaries(oldSummary), ...makeSummarySources(messages)]
    .map((source, index) => ({ ...source, id: `s${index + 1}` }));
}

/** Oldest-first and whole-message only: never advance coverage over omitted messages. */
export function fitSummaryMessages(messages: DialogMessage[], coreText: string | null, oldSummary = ""): DialogMessage[] {
  // Search actual timestamp-group boundaries: halving an index can cut the first
  // group and incorrectly reject it even when that complete group fits.
  const boundaries = messages.map((row, index) => index + 1)
    .filter(end => end === messages.length || messageTime(messages[end - 1]) !== messageTime(messages[end]));
  const chunkFits = (chunk: DialogMessage[]) => {
    const sources = oldSummary ? mergeSources(oldSummary, chunk) : makeSummarySources(chunk);
    return !summaryInputTooLarge(JSON.stringify({ sources, core: coreText }));
  };
  const fits = (end: number) => chunkFits(messages.slice(0, end));
  if (messages.length && fits(messages.length)) return messages;
  let low = 0, high = boundaries.length - 2, best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(boundaries[middle])) { best = boundaries[middle]; low = middle + 1; }
    else high = middle - 1;
  }
  if (best) return messages.slice(0, best);
  const clipped = clipFirstMessageGroup(messages, chunkFits);
  if (clipped) return clipped;
  throw new MemorySummaryInputError();
}

const CLIPPED_MESSAGE_MARK = " […сообщение сокращено для сводки]";
/**
 * The oldest timestamp group alone exceeds the input bound. Deferring never helps: the same
 * group comes back on every refresh, so the summary stalled for good. Its messages are
 * shortened from the end until the input fits, and coverage then moves past them.
 */
function clipFirstMessageGroup(messages: DialogMessage[], fits: (chunk: DialogMessage[]) => boolean): DialogMessage[] | null {
  if (!messages.length) return null;
  const group = messages.filter(row => messageTime(row) === messageTime(messages[0]));
  let low = 1, high = Math.max(...group.map(row => row.content.length)), best: DialogMessage[] | null = null;
  while (low <= high) {
    const limit = Math.floor((low + high) / 2);
    const chunk = group.map(row => row.content.length > limit ? { ...row, content: row.content.slice(0, limit).trimEnd() + CLIPPED_MESSAGE_MARK } : row);
    if (fits(chunk)) { best = chunk; low = limit + 1; } else high = limit - 1;
  }
  if (best) infoLog("Memory", `Summary input: clipped an oversized message group (${group.length} messages) so coverage can advance`);
  return best;
}

/**
 * Coverage moves only here, after the model returned a summary. Both coverage and text
 * must still match, so a concurrent refresh or manual edit cannot be overwritten.
 */
async function persistMemorySummary(
  scope: ChatScope,
  summary: string,
  lastSummarizedAt: Date,
  summarizedMessageCount: number,
  expectedCoverage: Date | null | "none",
  expectedSummary?: string,
  historyGuard?: (tx: Prisma.TransactionClient) => Promise<boolean>,
  expectedMemoryRevision?: number
): Promise<string | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (memoryV2Enabled()) {
        await lockMemoryThread(tx, scope.threadId);
        const thread = await tx.chatThread.findUnique({ where: { id: scope.threadId }, select: { memoryRevision: true } });
        if (!thread || expectedMemoryRevision !== undefined && thread.memoryRevision !== expectedMemoryRevision) return null;
      }
      if (historyGuard && !(await historyGuard(tx))) return null;
      const key = memoryScopeWhere(scope);
      if (expectedCoverage === "none") {
        await tx.memory.create({ data: { ...key, summary, lastSummarizedAt, summarizedMessageCount } });
      } else {
        const updated = await tx.memory.updateMany({
          where: { ...key, lastSummarizedAt: expectedCoverage, summary: expectedSummary },
          data: { summary, lastSummarizedAt, summarizedMessageCount },
        });
        if (!updated.count) return null;
      }
      await tx.memoryEntry.deleteMany({ where: { ...key, type: "summary" } });
      await tx.memoryEntry.create({ data: { ...key, type: "summary", content: summary } });
      if (memoryV2Enabled()) await tx.chatThread.update({ where: { id: scope.threadId }, data: { memorySummaryInvalidated: false } });
      return summary;
    });
  } catch (error) {
    if (expectedCoverage === "none" && (error as { code?: string })?.code === "P2002") {
      infoLog("Memory", "Summary create skipped: another refresh saved first");
      return null;
    }
    throw error;
  }
}

async function createArcSummary(
  scope: ChatScope,
  apiKey: string,
  messagesToSummarize: DialogMessage[],
  config: SummaryConfig,
  plan: string,
  onWrite?: (status: "updated" | "conflict") => void,
  snapshotRevision?: number
): Promise<string | null> {
  if (messagesToSummarize.length === 0) {
    return null;
  }

  const coreText = await loadCoreMemoryText(scope);
  const revision = snapshotRevision ?? (memoryV2Enabled() ? (await prisma.chatThread.findUniqueOrThrow({ where: { id: scope.threadId }, select: { memoryRevision: true } })).memoryRevision : undefined);
  messagesToSummarize = fitSummaryMessages(messagesToSummarize, coreText);
  const dialogText = formatDialogForSummary(messagesToSummarize);
  const tokens = countTokens(dialogText);
  const names = await summaryParticipants(scope, coreText);
  const attempt = await summarizeChunk(messagesToSummarize,
    chunk => requestSummary(apiKey, chunk, config.maxTokens, coreText, names));
  messagesToSummarize = attempt.used;
  const summary = attempt.summary ?? "";
  const saved = await persistMemorySummary(
    scope,
    summary,
    lastSummarizedTimestamp(messagesToSummarize),
    messagesToSummarize.length,
    "none", undefined, undefined, revision
  );
  onWrite?.(saved ? "updated" : "conflict");
  if (!saved) {
    const current = await prisma.memory.findUnique({ where: { threadId: scope.threadId }, select: { summary: true } });
    return current?.summary ?? null;
  }
  infoLog(
    "Memory",
    `Created arc summary (${messagesToSummarize.length} messages, ${tokens} tokens, subscription: ${plan})`
  );
  infoLog(
    "Memory",
    `Summary generated (subscription: ${plan}, maxTokens: ${config.maxTokens}, messageCount: ${messagesToSummarize.length}, summaryTokens: ${countTokens(summary)})`
  );
  infoLog("Memory", `Active lines count: ${countActiveLines(summary)}`);
  return summary;
}

async function updateArcWithChapter(
  scope: ChatScope,
  apiKey: string,
  existingSummary: string,
  existingCount: number,
  existingCoverage: Date | null,
  chapterMessages: DialogMessage[],
  config: SummaryConfig,
  plan: string,
  onWrite?: (status: "updated" | "conflict") => void,
  snapshotRevision?: number
): Promise<string | null> {
  const coreText = await loadCoreMemoryText(scope);
  const state = memoryV2Enabled() ? await prisma.chatThread.findUniqueOrThrow({ where: { id: scope.threadId },
    select: { memoryRevision: true, memorySummaryInvalidated: true } }) : null;
  const sourceSummary = state?.memorySummaryInvalidated ? "" : existingSummary;
  chapterMessages = fitSummaryMessages(chapterMessages, coreText, sourceSummary);
  const chapterText = formatDialogForSummary(chapterMessages);
  const chapterTokens = countTokens(chapterText);
  const arcTokens = countTokens(existingSummary);
  const arcRatio = config.maxTokens > 0 ? arcTokens / config.maxTokens : 0;
  const eventsLimit = getRecentEventsLimit(arcTokens, config.maxTokens);
  infoLog(
    "Memory",
    `Arc size: ${arcTokens} tokens (ratio: ${arcRatio.toFixed(2)}) → eventsLimit: ${eventsLimit}`
  );
  // One grounded update sees the actual new messages, not a twice-compressed chapter.
  const names = await summaryParticipants(scope, coreText);
  const attempt = await summarizeChunk(chapterMessages, chunk => requestChapterSummary(apiKey, sourceSummary, chunk,
    config.maxTokens, coreText, names));
  chapterMessages = attempt.used;
  // A skipped chunk keeps the previous retelling; coverage still moves on.
  const mergedSummary = attempt.summary ?? sourceSummary;
  const saved = await persistMemorySummary(
    scope,
    mergedSummary,
    lastSummarizedTimestamp(chapterMessages),
    existingCount + chapterMessages.length,
    existingCoverage,
    existingSummary, undefined, snapshotRevision ?? state?.memoryRevision
  );
  onWrite?.(saved ? "updated" : "conflict");
  if (!saved) {
    const current = await prisma.memory.findUnique({ where: { threadId: scope.threadId }, select: { summary: true } });
    return current?.summary ?? null;
  }
  infoLog(
    "Memory",
    `Created chapter (${chapterMessages.length} messages, ${chapterTokens} tokens) → merged into arc`
  );
  infoLog(
    "Memory",
    `Summary generated (subscription: ${plan}, maxTokens: ${config.maxTokens}, messageCount: ${chapterMessages.length}, summaryTokens: ${countTokens(mergedSummary)})`
  );
  infoLog("Memory", `Active lines count: ${countActiveLines(mergedSummary)}`);
  return mergedSummary;
}

async function refreshChatMemorySummary(
  scope: ChatScope,
  apiKey: string,
  user: {
    subscriptionType?: string | null;
    subscriptionEnd?: Date | string | null;
  }
): Promise<string | null> {
  await ensureMemoryHierarchyColumns();

  const { config, plan } = getSummaryConfigForUser(user);
  const maxContextTokens = getContextTokenLimit(user);
  const snapshotRevision = memoryV2Enabled() ? (await prisma.chatThread.findUniqueOrThrow({ where: { id: scope.threadId }, select: { memoryRevision: true } })).memoryRevision : undefined;

  const existingMemory = await prisma.memory.findUnique({
    where: { threadId: scope.threadId },
    select: {
      summary: true,
      createdAt: true,
      lastSummarizedAt: true,
      summarizedMessageCount: true,
    },
  });

  // Only lastSummarizedAt proves coverage. A summary row without it (manual edit, legacy row)
  // covers nothing, so every message still counts as new.
  const coverage = existingMemory?.lastSummarizedAt ?? null;
  const allMessages = await prisma.message.findMany({
    where: { ...messageScopeWhere(scope), ...(coverage ? { createdAt: { gt: coverage } } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { role: true, content: true, createdAt: true },
  });

  if (existingMemory) {
    // Only messages older than the kept recent window can be summarized. Counting that window
    // too kept a long story over the threshold forever: a paid merge of ~2 messages after
    // almost every turn (prod 2026-10-24).
    const historyToChapter = getHistoryForSummary(allMessages, maxContextTokens);
    const newTokens = historyToChapter.reduce((sum, message) => sum + countTokens(message.content), 0);
    const tokenThreshold = refreshTokenThreshold(config, maxContextTokens);

    if (
      historyToChapter.length < config.refreshMessageThreshold &&
      newTokens < tokenThreshold
    ) {
      infoLog(
        "Memory",
        `Skipped refresh (summarizable: ${historyToChapter.length} msgs, ${newTokens} tokens; threshold: ${config.refreshMessageThreshold} msgs / ${tokenThreshold} tokens)`
      );
      return existingMemory.summary;
    }

    return updateArcWithChapter(
      scope,
      apiKey,
      existingMemory.summary,
      existingMemory.summarizedMessageCount ?? 0,
      coverage,
      historyToChapter,
      config,
      plan, undefined, snapshotRevision
    );
  }

  const threshold = Math.floor(maxContextTokens * config.thresholdRatio);
  const totalTokens = allMessages.reduce((sum, message) => sum + countTokens(message.content), 0);

  if (totalTokens <= threshold) {
    infoLog(
      "Memory",
      `Skipped create (total: ${allMessages.length} msgs, ${totalTokens} tokens; threshold: ${threshold})`
    );
    return null;
  }

  const historyToSummarize = getHistoryForSummary(allMessages, maxContextTokens);
  if (historyToSummarize.length === 0) {
    return null;
  }

  return createArcSummary(scope, apiKey, historyToSummarize, config, plan, undefined, snapshotRevision);
}

export async function resolveChatMemorySummary(scope: ChatScope, apiKey: string,
  user: { subscriptionType?: string | null; subscriptionEnd?: Date | string | null }): Promise<string | null> {
  try {
    return await withSummaryRefreshLease(scope.threadId, () => refreshChatMemorySummary(scope, apiKey, user),
      () => readChatMemorySummary(scope));
  } catch (error) {
    if (!isDeferredSummaryFailure(error)) throw error;
    // The lease has already installed the size-limit cooldown. Preserve both the
    // previous memory and coverage, while keeping this visible in technical logs.
    infoLog("MemorySummary", "refresh deferred", { ...toSafeDiagnostic(error), stage: "size_limit",
      retryAfterMs: SUMMARY_SIZE_LIMIT_COOLDOWN_SECONDS * 1000 });
    return readChatMemorySummary(scope);
  }
}

export async function readChatMemorySummary(scope: ChatScope): Promise<string | null> {
  return (await readChatMemoryState(scope)).summary;
}

export type ChatMemoryState = {
  summary: string | null;
  /** createdAt of the last message proven to be in the summary; null = nothing is covered. */
  coveredUntil: Date | null;
  summarizedMessageCount: number;
};

export async function readChatMemoryState(scope: ChatScope): Promise<ChatMemoryState> {
  const existingMemory = await prisma.memory.findUnique({
    where: { threadId: scope.threadId },
    select: { summary: true, lastSummarizedAt: true, summarizedMessageCount: true },
  });
  let summary = existingMemory?.summary?.trim() || null;
  let coveredUntil = summary ? existingMemory?.lastSummarizedAt ?? null : null;
  if (memoryV2Enabled()) {
    const thread = await prisma.chatThread.findUnique({ where: { id: scope.threadId }, select: { memoryWatermarkMessageId: true, memorySummaryInvalidated: true } });
    if (thread?.memorySummaryInvalidated) summary = null;
    const processed = thread?.memoryWatermarkMessageId ? await prisma.message.findFirst({
      where: { id: thread.memoryWatermarkMessageId, threadId: scope.threadId }, select: { createdAt: true },
    }) : null;
    // Both summary and structured memory must have processed a message before it
    // can leave the protected raw suffix. No model call is added to the hot path.
    coveredUntil = coveredUntil && processed ? new Date(Math.min(coveredUntil.getTime(), processed.createdAt.getTime())) : null;
  }
  return {
    summary,
    coveredUntil,
    summarizedMessageCount: existingMemory?.summarizedMessageCount ?? 0,
  };
}

export async function forceRefreshMemorySummary(
  scope: ChatScope,
  apiKey: string,
  user?: {
    subscriptionType?: string | null;
    subscriptionEnd?: Date | string | null;
  },
  onWrite?: (status: "updated" | "conflict") => void
): Promise<string | null> {
  await ensureMemoryHierarchyColumns();

  const loadedUser =
    user ??
    (await prisma.user.findUnique({
      where: { id: scope.userId },
      select: { subscriptionType: true, subscriptionEnd: true },
    }));
  const { config, plan } = getSummaryConfigForUser(loadedUser ?? {});
  const snapshotRevision = memoryV2Enabled() ? (await prisma.chatThread.findUniqueOrThrow({ where: { id: scope.threadId }, select: { memoryRevision: true } })).memoryRevision : undefined;

  const existingMemory = await prisma.memory.findUnique({
    where: { threadId: scope.threadId },
    select: {
      summary: true,
      createdAt: true,
      lastSummarizedAt: true,
      summarizedMessageCount: true,
    },
  });

  const allMessages = await prisma.message.findMany({
    where: messageScopeWhere(scope),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { role: true, content: true, createdAt: true },
  });

  if (allMessages.length === 0) {
    return null;
  }

  const contextTokens = getContextTokenLimit(loadedUser);
  if (!existingMemory) {
    const historyToSummarize =
      allMessages.length > recentWindowSize(allMessages, contextTokens)
        ? getHistoryForSummary(allMessages, contextTokens)
        : allMessages.slice(0, MAX_SUMMARY_CHUNK_MESSAGES);
    return createArcSummary(scope, apiKey, historyToSummarize, config, plan, onWrite, snapshotRevision);
  }

  const coverage = existingMemory.lastSummarizedAt ?? null;
  const newMessages = coverage ? allMessages.filter((message) => message.createdAt > coverage) : allMessages;
  const chapterMessages =
    newMessages.length === 0
      ? []
      : newMessages.length <= recentWindowSize(newMessages, contextTokens)
        ? newMessages.slice(0, MAX_SUMMARY_CHUNK_MESSAGES)
        : getHistoryForSummary(newMessages, contextTokens);

  if (chapterMessages.length === 0) {
    return existingMemory.summary;
  }

  return updateArcWithChapter(
    scope,
    apiKey,
    existingMemory.summary,
    existingMemory.summarizedMessageCount ?? 0,
    coverage,
    chapterMessages,
    config,
    plan,
    onWrite, snapshotRevision
  );
}

export async function refreshMemorySummaryWithStatus(
  scope: ChatScope, apiKey: string,
  user?: { subscriptionType?: string | null; subscriptionEnd?: Date | string | null }
) {
  const progress: { status: "updated" | "conflict" | "unchanged" | "empty" } = { status: "unchanged" };
  const text = await forceRefreshMemorySummary(scope, apiKey, user, (result) => { progress.status = result; });
  // Re-read canonical storage even after a successful write; an editor may have saved meanwhile.
  const summary = await prisma.memory.findUnique({
    where: { threadId: scope.threadId }, select: { summary: true, createdAt: true },
  });
  if (!text && progress.status === "unchanged") progress.status = "empty";
  const status = progress.status;
  return { summary, status, updated: status === "updated" };
}

export class MemorySummaryInputError extends Error {
  constructor() { super("Memory summary input exceeds bounded processing limit"); this.name = "MemorySummaryInputError"; }
}

type RebuildCursor = {
  version: 2; userId: string; characterId: string; threadId: string; snapshot: string;
  historyRevision: string;
  through: string; after: string | null; processed: number; total: number;
  draft: string; expires: number;
};

async function rebuildHistoryRevision(scope: ChatScope, through: Date, tx?: Prisma.TransactionClient): Promise<string> {
  const client = tx ?? prisma;
  const { userId, characterId, threadId, legacy } = scope;
  // Final commit locks the source rows briefly; edits/regeneration/deletion cannot publish a stale rebuilt summary.
  const [row] = tx ? await client.$queryRaw<Array<{ revision: string | null }>>`
    WITH source AS (SELECT "id", "role", "content", "createdAt" FROM "Message"
      WHERE "userId" = ${userId} AND "characterId" = ${characterId}
        AND ("threadId" = ${threadId} OR (${legacy}::boolean AND "threadId" IS NULL)) AND "createdAt" <= ${through} FOR SHARE)
    SELECT md5(string_agg(md5("id" || ':' || "role" || ':' || "content"), ',' ORDER BY "createdAt", "id")) AS revision FROM source
  ` : await client.$queryRaw<Array<{ revision: string | null }>>`
    SELECT md5(string_agg(md5("id" || ':' || "role" || ':' || "content"), ',' ORDER BY "createdAt", "id")) AS revision
    FROM "Message" WHERE "userId" = ${userId} AND "characterId" = ${characterId}
      AND ("threadId" = ${threadId} OR (${legacy}::boolean AND "threadId" IS NULL)) AND "createdAt" <= ${through}
  `;
  return row.revision ?? "empty";
}
function rebuildSecret(): string {
  const secret = process.env['NEXTAUTH_SECRET'];
  if (!secret) throw new Error("NEXTAUTH_SECRET is required");
  return secret;
}
function summarySnapshot(row: { id: string; summary: string; lastSummarizedAt: Date | null } | null): string {
  return createHash("sha256").update(JSON.stringify(row ? [row.id, row.summary, row.lastSummarizedAt?.toISOString()] : null)).digest("hex");
}
function signRebuildCursor(cursor: RebuildCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${encoded}.${createHmac("sha256", rebuildSecret()).update(`memory-rebuild:${encoded}`).digest("base64url")}`;
}
function readRebuildCursor(token: string, scope: ChatScope): RebuildCursor {
  if (token.length > 30_000) throw new MemoryRebuildCursorError();
  const parts = token.split(".");
  if (parts.length !== 2) throw new MemoryRebuildCursorError();
  const expected = createHmac("sha256", rebuildSecret()).update(`memory-rebuild:${parts[0]}`).digest();
  const supplied = Buffer.from(parts[1], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new MemoryRebuildCursorError();
  const cursor = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as RebuildCursor;
  if (cursor.version !== 2 || cursor.userId !== scope.userId || cursor.characterId !== scope.characterId
    || cursor.threadId !== scope.threadId
    || cursor.expires < Date.now() || !Number.isFinite(Date.parse(cursor.through))
    || (cursor.after !== null && !Number.isFinite(Date.parse(cursor.after)))) throw new MemoryRebuildCursorError();
  return cursor;
}

export class MemoryRebuildCursorError extends Error {
  constructor() { super("Invalid rebuild continuation"); this.name = "MemoryRebuildCursorError"; }
}

/** One request = one bounded model call. Draft is signed, client-carried, never published until complete. */
export async function rebuildMemorySummaryStep(
  scope: ChatScope, apiKey: string,
  user: { subscriptionType?: string | null; subscriptionEnd?: Date | string | null }, continuation?: string
) {
  const current = await prisma.memory.findUnique({ where: { threadId: scope.threadId } });
  let cursor: RebuildCursor;
  if (continuation) cursor = readRebuildCursor(continuation, scope);
  else {
    // Like the background refresh, a rebuild leaves the kept recent window alone: those messages go
    // to the prompt verbatim. Summarizing them filled half a 196-message summary with the last scene
    // and squeezed the middle of the story (prod 2026-10-24). A timestamp group is never split.
    const newest = await prisma.message.findMany({ where: messageScopeWhere(scope), orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: KEEP_RECENT_MESSAGES + 1, select: { createdAt: true, content: true, role: true } });
    const keep = recentWindowSize([...newest].reverse(), getContextTokenLimit(user));
    let latest: { createdAt: Date } | null = newest.length > keep ? newest[keep] : null;
    if (latest && newest[keep - 1].createdAt.getTime() === latest.createdAt.getTime()) {
      latest = await prisma.message.findFirst({ where: { ...messageScopeWhere(scope), createdAt: { lt: latest.createdAt } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true } });
    }
    if (!latest) return { status: "empty" as const, updated: false, summary: null };
    const total = await prisma.message.count({ where: { ...messageScopeWhere(scope), createdAt: { lte: latest.createdAt } } });
    cursor = { version: 2, userId: scope.userId, characterId: scope.characterId, threadId: scope.threadId, snapshot: summarySnapshot(current),
      historyRevision: await rebuildHistoryRevision(scope, latest.createdAt), through: latest.createdAt.toISOString(),
      after: null, processed: 0, total, draft: "", expires: Date.now() + 15 * 60_000 };
  }
  if (summarySnapshot(current) !== cursor.snapshot
    || await rebuildHistoryRevision(scope, new Date(cursor.through)) !== cursor.historyRevision) {
    return { status: "conflict" as const, updated: false, summary: current ? { summary: current.summary, createdAt: current.createdAt } : null };
  }
  const rows = await prisma.message.findMany({
    where: { ...messageScopeWhere(scope), createdAt: { lte: new Date(cursor.through), ...(cursor.after ? { gt: new Date(cursor.after) } : {}) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: MAX_SUMMARY_CHUNK_MESSAGES + 1,
    select: { role: true, content: true, createdAt: true },
  });
  // Preserve timestamp coverage semantics, including equal-time groups. Bound input before the AI call.
  const all = takeSummaryChunk(rows, 0);
  const chunkFits = (candidate: DialogMessage[]) => !summaryInputTooLarge(JSON.stringify(mergeSources(cursor.draft, candidate)), MAX_SUMMARY_INPUT_TOKENS - 2000);
  let chunk = all;
  while (chunk.length && !chunkFits(chunk)) {
    const end = messageTime(chunk[chunk.length - 1]);
    chunk = chunk.filter((row) => messageTime(row) !== end);
  }
  if (!chunk.length) chunk = clipFirstMessageGroup(all, chunkFits) ?? [];
  if (!chunk.length) throw new MemorySummaryInputError();
  const { config } = getSummaryConfigForUser(user);
  const coreText = await loadCoreMemoryText(scope);
  const names = await summaryParticipants(scope, coreText), draft = cursor.draft;
  const attempt = await summarizeChunk(chunk, part => requestChapterSummary(apiKey, draft, part, config.maxTokens, coreText, names));
  chunk = attempt.used;
  cursor.draft = attempt.summary ?? draft;
  cursor.after = lastSummarizedTimestamp(chunk).toISOString();
  cursor.processed += chunk.length;
  const remaining = await prisma.message.count({ where: { ...messageScopeWhere(scope), createdAt: { gt: new Date(cursor.after), lte: new Date(cursor.through) } } });
  if (remaining) return { status: "rebuilding" as const, updated: false, processed: cursor.processed, total: cursor.total,
    continuation: signRebuildCursor(cursor) };
  const saved = await persistMemorySummary(scope, cursor.draft, new Date(cursor.after), cursor.processed,
    current ? current.lastSummarizedAt : "none", current?.summary,
    async (tx) => await rebuildHistoryRevision(scope, new Date(cursor.through), tx) === cursor.historyRevision);
  const summary = await prisma.memory.findUnique({ where: { threadId: scope.threadId }, select: { summary: true, createdAt: true } });
  return { status: saved ? "updated" as const : "conflict" as const, updated: Boolean(saved), summary, processed: cursor.processed, total: cursor.total };
}
