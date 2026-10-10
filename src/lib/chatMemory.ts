import { meteredPost } from "@/lib/aiCostTelemetry";
import { countTokens } from "@/lib/tokenCount";
import { prisma } from "@/lib/prisma";
import { getContextTokenLimit } from "@/lib/chatEconomy";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";
import { ensureMemoryHierarchyColumns } from "@/lib/ensureMemoryHierarchyColumns";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { sanitizeCoreMemory } from "@/lib/coreMemorySanitize";
import { GROUNDED_SUMMARY_RULES, makeSummarySources, renderGroundedSummary, sourcesFromSummaries, type SummarySource } from "@/lib/memorySummaryEvidence";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  fetchEmbeddings,
  hasDistinctKeyTokens,
  keepUniqueByCosine,
  logSimilarityMatrix,
  SEMANTIC_DEDUP_THRESHOLD,
} from "@/lib/memoryEmbeddings";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const SUMMARY_MODEL = "openai/gpt-4o-mini";
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

const SUMMARY_PROMPT = `Ты — суммаризатор ролевых диалогов. Сохрани смысл, действующие планы и изменения состояния по исходной переписке.`;
const MERGE_PROMPT = `Ты — суммаризатор ролевых диалогов. Обнови краткую сводку по новой части переписки. Сохрани содержание открытых планов, объедини повторы; различай предложение, решение, выполнение и отмену. При неясном противоречии не угадывай.`;
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

function applyPromptVars(prompt: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
    prompt
  );
}

type SummarySections = {
  state?: string;
  decisions?: string;
  permanent?: string;
  activeLines?: string;
  events?: string;
  emotion?: string;
};

const HEADING_MAP: Array<{ key: keyof SummarySections; test: RegExp }> = [
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

function getHistoryForSummary(messages: DialogMessage[]): DialogMessage[] {
  return takeSummaryChunk(messages);
}

async function loadCoreMemoryText(userId: string, characterId: string): Promise<string | null> {
  const row = await prisma.coreMemory.findUnique({
    where: { userId_characterId: { userId, characterId } },
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
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  extraVars: Record<string, string | number> = {}
): Promise<string> {
  const response = await meteredPost("summary",
    `${KODIKROUTER_URL}/chat/completions`,
    {
      model: SUMMARY_MODEL,
      messages: [
        {
          role: "system",
          content: applyPromptVars(systemPrompt, { maxTokens, ...extraVars }) + "\n\n" + GROUNDED_SUMMARY_RULES
            + `\nОтвет целиком должен поместиться в ${maxTokens} токенов. Максимум ${Math.min(10, Math.max(1, Math.floor(maxTokens / 120)))} пунктов, коротко, без markdown-обёртки.`,
        },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const text = response.data.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("Пустая суммаризация от ИИ");
  }

  return text;
}

async function requestSelectedSummary(
  apiKey: string, prompt: string, sources: SummarySource[], maxTokens: number,
  coreText: string | null
): Promise<string> {
  if (!sources.length) throw new Error("No memory source quotes available");
  // JSON output overhead uses the existing output allowance, never an unbounded extra call.
  const input = JSON.stringify({ sources, core: coreText });
  if (summaryInputTooLarge(input)) throw new MemorySummaryInputError();
  const raw = await requestKodikText(apiKey, prompt,
    input, maxTokens);
  const summary = renderGroundedSummary(raw, sources, maxTokens, countTokens);
  if (!summary) throw new Error("No supported memory quotes selected");
  return summary;
}

async function requestSummary(apiKey: string, messages: DialogMessage[], maxTokens: number, coreText: string | null): Promise<string> {
  return requestSelectedSummary(apiKey, SUMMARY_PROMPT, makeSummarySources(messages), maxTokens, coreText);
}

function mergeSources(oldSummary: string, messages: DialogMessage[]): SummarySource[] {
  return [...sourcesFromSummaries(oldSummary), ...makeSummarySources(messages)]
    .map((source, index) => ({ ...source, id: `s${index + 1}` }));
}

/**
 * Coverage moves only here, after the model returned a summary. Both coverage and text
 * must still match, so a concurrent refresh or manual edit cannot be overwritten.
 */
async function persistMemorySummary(
  userId: string,
  characterId: string,
  summary: string,
  lastSummarizedAt: Date,
  summarizedMessageCount: number,
  expectedCoverage: Date | null | "none",
  expectedSummary?: string,
  historyGuard?: (tx: Prisma.TransactionClient) => Promise<boolean>
): Promise<string | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (historyGuard && !(await historyGuard(tx))) return null;
      if (expectedCoverage === "none") {
        await tx.memory.create({ data: { userId, characterId, summary, lastSummarizedAt, summarizedMessageCount } });
      } else {
        const updated = await tx.memory.updateMany({
          where: { userId, characterId, lastSummarizedAt: expectedCoverage, summary: expectedSummary },
          data: { summary, lastSummarizedAt, summarizedMessageCount },
        });
        if (!updated.count) return null;
      }
      await tx.memoryEntry.deleteMany({ where: { userId, characterId, type: "summary" } });
      await tx.memoryEntry.create({ data: { userId, characterId, type: "summary", content: summary } });
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
  userId: string,
  characterId: string,
  apiKey: string,
  messagesToSummarize: DialogMessage[],
  config: SummaryConfig,
  plan: string,
  onWrite?: (status: "updated" | "conflict") => void
): Promise<string | null> {
  if (messagesToSummarize.length === 0) {
    return null;
  }

  const dialogText = formatDialogForSummary(messagesToSummarize);
  const tokens = countTokens(dialogText);
  const coreText = await loadCoreMemoryText(userId, characterId);
  const summary = await requestSummary(apiKey, messagesToSummarize, config.maxTokens, coreText);
  const saved = await persistMemorySummary(
    userId,
    characterId,
    summary,
    lastSummarizedTimestamp(messagesToSummarize),
    messagesToSummarize.length,
    "none"
  );
  onWrite?.(saved ? "updated" : "conflict");
  if (!saved) {
    const current = await prisma.memory.findUnique({ where: { userId_characterId: { userId, characterId } }, select: { summary: true } });
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
  userId: string,
  characterId: string,
  apiKey: string,
  existingSummary: string,
  existingCount: number,
  existingCoverage: Date | null,
  chapterMessages: DialogMessage[],
  config: SummaryConfig,
  plan: string,
  onWrite?: (status: "updated" | "conflict") => void
): Promise<string | null> {
  const chapterText = formatDialogForSummary(chapterMessages);
  const chapterTokens = countTokens(chapterText);
  const arcTokens = countTokens(existingSummary);
  const arcRatio = config.maxTokens > 0 ? arcTokens / config.maxTokens : 0;
  const eventsLimit = getRecentEventsLimit(arcTokens, config.maxTokens);
  infoLog(
    "Memory",
    `Arc size: ${arcTokens} tokens (ratio: ${arcRatio.toFixed(2)}) → eventsLimit: ${eventsLimit}`
  );
  const coreText = await loadCoreMemoryText(userId, characterId);
  // One grounded update sees the actual new messages, not a twice-compressed chapter.
  const mergedSummary = await requestSelectedSummary(apiKey, MERGE_PROMPT,
    mergeSources(existingSummary, chapterMessages), config.maxTokens, coreText);
  const saved = await persistMemorySummary(
    userId,
    characterId,
    mergedSummary,
    lastSummarizedTimestamp(chapterMessages),
    existingCount + chapterMessages.length,
    existingCoverage,
    existingSummary
  );
  onWrite?.(saved ? "updated" : "conflict");
  if (!saved) {
    const current = await prisma.memory.findUnique({ where: { userId_characterId: { userId, characterId } }, select: { summary: true } });
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

export async function resolveChatMemorySummary(
  userId: string,
  characterId: string,
  apiKey: string,
  user: {
    subscriptionType?: string | null;
    subscriptionEnd?: Date | string | null;
  }
): Promise<string | null> {
  await ensureMemoryHierarchyColumns();

  const { config, plan } = getSummaryConfigForUser(user);
  const maxContextTokens = getContextTokenLimit(user);

  const existingMemory = await prisma.memory.findUnique({
    where: {
      userId_characterId: {
        userId,
        characterId,
      },
    },
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
    where: { userId, characterId, ...(coverage ? { createdAt: { gt: coverage } } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { role: true, content: true, createdAt: true },
  });

  if (existingMemory) {
    const newMessages = allMessages;
    const newTokens = newMessages.reduce((sum, message) => sum + countTokens(message.content), 0);

    if (
      newMessages.length < config.refreshMessageThreshold &&
      newTokens < config.refreshTokenThreshold
    ) {
      infoLog(
        "Memory",
        `Skipped refresh (new: ${newMessages.length} msgs, ${newTokens} tokens; threshold: ${config.refreshMessageThreshold} msgs / ${config.refreshTokenThreshold} tokens)`
      );
      return existingMemory.summary;
    }

    const historyToChapter = getHistoryForSummary(newMessages);
    if (historyToChapter.length === 0) {
      return existingMemory.summary;
    }

    return updateArcWithChapter(
      userId,
      characterId,
      apiKey,
      existingMemory.summary,
      existingMemory.summarizedMessageCount ?? 0,
      coverage,
      historyToChapter,
      config,
      plan
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

  const historyToSummarize = getHistoryForSummary(allMessages);
  if (historyToSummarize.length === 0) {
    return null;
  }

  return createArcSummary(userId, characterId, apiKey, historyToSummarize, config, plan);
}

export async function readChatMemorySummary(
  userId: string,
  characterId: string
): Promise<string | null> {
  return (await readChatMemoryState(userId, characterId)).summary;
}

export type ChatMemoryState = {
  summary: string | null;
  /** createdAt of the last message proven to be in the summary; null = nothing is covered. */
  coveredUntil: Date | null;
  summarizedMessageCount: number;
};

export async function readChatMemoryState(userId: string, characterId: string): Promise<ChatMemoryState> {
  const existingMemory = await prisma.memory.findUnique({
    where: { userId_characterId: { userId, characterId } },
    select: { summary: true, lastSummarizedAt: true, summarizedMessageCount: true },
  });
  const summary = existingMemory?.summary?.trim() || null;
  return {
    summary,
    coveredUntil: summary ? existingMemory?.lastSummarizedAt ?? null : null,
    summarizedMessageCount: existingMemory?.summarizedMessageCount ?? 0,
  };
}

export async function forceRefreshMemorySummary(
  userId: string,
  characterId: string,
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
      where: { id: userId },
      select: { subscriptionType: true, subscriptionEnd: true },
    }));
  const { config, plan } = getSummaryConfigForUser(loadedUser ?? {});

  const existingMemory = await prisma.memory.findUnique({
    where: { userId_characterId: { userId, characterId } },
    select: {
      summary: true,
      createdAt: true,
      lastSummarizedAt: true,
      summarizedMessageCount: true,
    },
  });

  const allMessages = await prisma.message.findMany({
    where: { userId, characterId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { role: true, content: true, createdAt: true },
  });

  if (allMessages.length === 0) {
    return null;
  }

  if (!existingMemory) {
    const historyToSummarize =
      allMessages.length > KEEP_RECENT_MESSAGES
        ? getHistoryForSummary(allMessages)
        : allMessages.slice(0, MAX_SUMMARY_CHUNK_MESSAGES);
    return createArcSummary(userId, characterId, apiKey, historyToSummarize, config, plan, onWrite);
  }

  const coverage = existingMemory.lastSummarizedAt ?? null;
  const newMessages = coverage ? allMessages.filter((message) => message.createdAt > coverage) : allMessages;
  const chapterMessages =
    newMessages.length === 0
      ? []
      : newMessages.length <= KEEP_RECENT_MESSAGES
        ? newMessages.slice(0, MAX_SUMMARY_CHUNK_MESSAGES)
        : getHistoryForSummary(newMessages);

  if (chapterMessages.length === 0) {
    return existingMemory.summary;
  }

  return updateArcWithChapter(
    userId,
    characterId,
    apiKey,
    existingMemory.summary,
    existingMemory.summarizedMessageCount ?? 0,
    coverage,
    chapterMessages,
    config,
    plan,
    onWrite
  );
}

export async function refreshMemorySummaryWithStatus(
  userId: string, characterId: string, apiKey: string,
  user?: { subscriptionType?: string | null; subscriptionEnd?: Date | string | null }
) {
  const progress: { status: "updated" | "conflict" | "unchanged" | "empty" } = { status: "unchanged" };
  const text = await forceRefreshMemorySummary(userId, characterId, apiKey, user, (result) => { progress.status = result; });
  // Re-read canonical storage even after a successful write; an editor may have saved meanwhile.
  const summary = await prisma.memory.findUnique({
    where: { userId_characterId: { userId, characterId } }, select: { summary: true, createdAt: true },
  });
  if (!text && progress.status === "unchanged") progress.status = "empty";
  const status = progress.status;
  return { summary, status, updated: status === "updated" };
}

export class MemorySummaryInputError extends Error {
  constructor() { super("Memory summary input exceeds bounded processing limit"); this.name = "MemorySummaryInputError"; }
}

type RebuildCursor = {
  version: 1; userId: string; characterId: string; snapshot: string;
  historyRevision: string;
  through: string; after: string | null; processed: number; total: number;
  draft: string; expires: number;
};

async function rebuildHistoryRevision(userId: string, characterId: string, through: Date, tx?: Prisma.TransactionClient): Promise<string> {
  const client = tx ?? prisma;
  // Final commit locks the source rows briefly; edits/regeneration/deletion cannot publish a stale rebuilt summary.
  const [row] = tx ? await client.$queryRaw<Array<{ revision: string | null }>>`
    WITH source AS (SELECT "id", "role", "content", "createdAt" FROM "Message"
      WHERE "userId" = ${userId} AND "characterId" = ${characterId} AND "createdAt" <= ${through} FOR SHARE)
    SELECT md5(string_agg(md5("id" || ':' || "role" || ':' || "content"), ',' ORDER BY "createdAt", "id")) AS revision FROM source
  ` : await client.$queryRaw<Array<{ revision: string | null }>>`
    SELECT md5(string_agg(md5("id" || ':' || "role" || ':' || "content"), ',' ORDER BY "createdAt", "id")) AS revision
    FROM "Message" WHERE "userId" = ${userId} AND "characterId" = ${characterId} AND "createdAt" <= ${through}
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
function readRebuildCursor(token: string, userId: string, characterId: string): RebuildCursor {
  if (token.length > 30_000) throw new MemoryRebuildCursorError();
  const parts = token.split(".");
  if (parts.length !== 2) throw new MemoryRebuildCursorError();
  const expected = createHmac("sha256", rebuildSecret()).update(`memory-rebuild:${parts[0]}`).digest();
  const supplied = Buffer.from(parts[1], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new MemoryRebuildCursorError();
  const cursor = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as RebuildCursor;
  if (cursor.version !== 1 || cursor.userId !== userId || cursor.characterId !== characterId
    || cursor.expires < Date.now() || !Number.isFinite(Date.parse(cursor.through))
    || (cursor.after !== null && !Number.isFinite(Date.parse(cursor.after)))) throw new MemoryRebuildCursorError();
  return cursor;
}

export class MemoryRebuildCursorError extends Error {
  constructor() { super("Invalid rebuild continuation"); this.name = "MemoryRebuildCursorError"; }
}

/** One request = one bounded model call. Draft is signed, client-carried, never published until complete. */
export async function rebuildMemorySummaryStep(
  userId: string, characterId: string, apiKey: string,
  user: { subscriptionType?: string | null; subscriptionEnd?: Date | string | null }, continuation?: string
) {
  const current = await prisma.memory.findUnique({ where: { userId_characterId: { userId, characterId } } });
  let cursor: RebuildCursor;
  if (continuation) cursor = readRebuildCursor(continuation, userId, characterId);
  else {
    const latest = await prisma.message.findFirst({ where: { userId, characterId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (!latest) return { status: "empty" as const, updated: false, summary: null };
    const total = await prisma.message.count({ where: { userId, characterId, createdAt: { lte: latest.createdAt } } });
    cursor = { version: 1, userId, characterId, snapshot: summarySnapshot(current),
      historyRevision: await rebuildHistoryRevision(userId, characterId, latest.createdAt), through: latest.createdAt.toISOString(),
      after: null, processed: 0, total, draft: "", expires: Date.now() + 15 * 60_000 };
  }
  if (summarySnapshot(current) !== cursor.snapshot
    || await rebuildHistoryRevision(userId, characterId, new Date(cursor.through)) !== cursor.historyRevision) {
    return { status: "conflict" as const, updated: false, summary: current ? { summary: current.summary, createdAt: current.createdAt } : null };
  }
  const rows = await prisma.message.findMany({
    where: { userId, characterId, createdAt: { lte: new Date(cursor.through), ...(cursor.after ? { gt: new Date(cursor.after) } : {}) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: MAX_SUMMARY_CHUNK_MESSAGES + 1,
    select: { role: true, content: true, createdAt: true },
  });
  // Preserve timestamp coverage semantics, including equal-time groups. Bound input before the AI call.
  let chunk = takeSummaryChunk(rows, 0);
  while (chunk.length && summaryInputTooLarge(JSON.stringify(mergeSources(cursor.draft, chunk)), MAX_SUMMARY_INPUT_TOKENS - 2000)) {
    const end = messageTime(chunk[chunk.length - 1]);
    chunk = chunk.filter((row) => messageTime(row) !== end);
  }
  if (!chunk.length) throw new MemorySummaryInputError();
  const { config } = getSummaryConfigForUser(user);
  const coreText = await loadCoreMemoryText(userId, characterId);
  cursor.draft = await requestSelectedSummary(apiKey, cursor.draft ? MERGE_PROMPT : SUMMARY_PROMPT,
    mergeSources(cursor.draft, chunk), config.maxTokens, coreText);
  cursor.after = lastSummarizedTimestamp(chunk).toISOString();
  cursor.processed += chunk.length;
  const remaining = await prisma.message.count({ where: { userId, characterId, createdAt: { gt: new Date(cursor.after), lte: new Date(cursor.through) } } });
  if (remaining) return { status: "rebuilding" as const, updated: false, processed: cursor.processed, total: cursor.total,
    continuation: signRebuildCursor(cursor) };
  const saved = await persistMemorySummary(userId, characterId, cursor.draft, new Date(cursor.after), cursor.processed,
    current ? current.lastSummarizedAt : "none", current?.summary,
    async (tx) => await rebuildHistoryRevision(userId, characterId, new Date(cursor.through), tx) === cursor.historyRevision);
  const summary = await prisma.memory.findUnique({ where: { userId_characterId: { userId, characterId } }, select: { summary: true, createdAt: true } });
  return { status: saved ? "updated" as const : "conflict" as const, updated: Boolean(saved), summary, processed: cursor.processed, total: cursor.total };
}
