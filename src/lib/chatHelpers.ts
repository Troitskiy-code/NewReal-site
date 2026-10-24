import { meteredPost, meteredChatFetch, aiCostDiagnosticContext } from "@/lib/aiCostTelemetry";
import { availableChatModel, chatModelNameFilter, chatTransport, getChatProvider, AiProviderConfigurationError } from "./aiProviders";
import { countTokens } from "@/lib/tokenCount";
import { prisma } from "@/lib/prisma";
import {
  episodicLimitForIntent,
  formatEpisodicLine,
  loadMemoryCandidates,
  rankEpisodicCandidates,
  sortEpisodicChronologically,
  type EpisodicMemoryItem,
  type MemoryCandidates,
} from "@/lib/advancedMemory";
import { getSelectedChatPersona } from "@/lib/personaService";
import { assembleRoleplayPrompt, fitPromptAssembly, type PromptAssemblyOptions, type PromptAssembly } from "@/lib/chatSystemPrompt";
import { roleplayMode } from "./roleplayConfig";
import { getOrCreateThreadPromptState, assertPromptStateAvailable, type PromptState } from "@/lib/promptState";
import { messageScopeWhere, type ChatScope } from "@/lib/chatThreads";
import { promptAssemblyDiagnostics, logPromptDelivery } from "@/lib/promptDiagnostics";
import { readChatMemoryState, resolveChatMemorySummary } from "@/lib/chatMemory";
import { appendMemorySection, type MemoryBlock, type MemoryBlockKind } from "@/lib/memoryPromptFormat";
import { isTrivialEvent, memoryOverlap } from "@/lib/memoryNarrative";
import type { UserIntent } from "@/lib/intentAnalyzer";
import {
  isRagEligible,
  shouldUseRag,
  searchRelevantMessages,
  type RagMessage,
} from "@/lib/messageEmbeddings";
import { buildRagSearchQuery, fitRagExcerpts, excludeRecentRagSources, limitRagHistoryToQuery } from "@/lib/ragRetrieval";
import {
  getContextTokenLimit,
  getHistoryMessageLimit,
  isSubscriptionActive,
  type EconomyModel,
} from "@/lib/verseChatEconomy";
import { applyPendingSubscriptionIfDue } from "@/lib/subscriptionState";
import { getPermanentCoins, spendCoins } from "@/lib/verseCoins";
import { FREE_CHAT_TRANSACTION_TYPE, getFreeQuotaState, isSameMoscowDay, type FreeQuotaState } from "@/lib/freeDailyQuota";
import { debugLog, infoLog, errorLog , toSafeDiagnostic} from "@/lib/logger";
import { retryWithBackoff, defaultShouldRetry } from "@/lib/retryWithBackoff";
import { chatModelGenerationOptions, chatModelRequestTimeoutMs, chatModelStreamTimeouts } from "@/lib/testingChatModels";

export const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
export const MAX_OUTPUT_TOKENS = 1000;

export type ChatCompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CharacterForChat = {
  id: string;
  name: string;
  description: string | null;
  appearance: string | null;
  greeting: string | null;
  scenario: string | null;
  exampleDialogs: string | null;
  isPublic: boolean;
  userId: string;
  name_en?: string | null;
  description_en?: string | null;
  appearance_en?: string | null;
  greeting_en?: string | null;
  scenario_en?: string | null;
  exampleDialogs_en?: string | null;
  roleplayMode?: string | null;
  roleplayStyle?: string | null;
  rpConfig?: unknown;
};

export const promptCharacterSelect = {
  roleplayMode: true, roleplayStyle: true, rpConfig: true,
} as const;

export function localizeCharacterForChat(
  character: CharacterForChat,
  locale: string | null | undefined
): CharacterForChat {
  if (locale !== "en") return character;

  return {
    ...character,
    name: character.name_en?.trim() || character.name,
    description: character.description_en?.trim() || character.description,
    appearance: character.appearance_en?.trim() || character.appearance,
    greeting: character.greeting_en?.trim() || character.greeting,
    scenario: character.scenario_en?.trim() || character.scenario,
    exampleDialogs: character.exampleDialogs_en?.trim() || character.exampleDialogs,
  };
}

export function resolveChatSystemPrompt(
  character: CharacterForChat,
  locale: string | null | undefined,
  state?: PromptState,
  options: PromptAssemblyOptions = {}
): string {
  return resolveChatPromptAssembly(character, locale, state, options).content;
}

export function resolveChatPromptAssembly(character: CharacterForChat, locale: string | null | undefined, state?: PromptState, options: PromptAssemblyOptions = {}): PromptAssembly {
  assertPromptStateAvailable({ builderVersion: 2, mode: state?.mode ?? roleplayMode(character.roleplayMode) }, character.rpConfig);
  const assembly = assembleRoleplayPrompt(localizeCharacterForChat(character, locale), locale, { ...options, ...(state ? { mode: state.mode } : {}) });
  return options.tokenBudget ? fitPromptAssembly(assembly, options.tokenBudget, countTokens) : assembly;
}

export type ChatUser = {
  id: string;
  verseCoins: number;
  subscriptionType: string | null;
  subscriptionEnd: Date | null;
  dailyRequests: number;
  dailyRequestsDate: Date;
  createdAt: Date;
};

export const modelSelect = {
  id: true,
  name: true,
  displayName: true,
  priceVC: true,
  maxContextTokens: true,
  isActive: true,
} as const;

export { countTokens };

export function trimMessagesToTokenLimit(
  messages: ChatCompletionMessage[],
  maxTokens: number
): { messages: ChatCompletionMessage[]; totalTokens: number } {
  const trimmed = [...messages];
  let totalTokens = trimmed.reduce((sum, message) => sum + countTokens(message.content), 0);

  while (totalTokens > maxTokens && trimmed.length > 2) {
    const removed = trimmed.splice(1, 1)[0];
    totalTokens -= countTokens(removed.content);
  }

  return { messages: trimmed, totalTokens };
}

export const MEMORY_TOKEN_RATIOS = {
  recentChat: 0.6,
  summary: 0.2,
  retrieved: 0.1,
  coreEpisodic: 0.1,
} as const;

export type MemoryTokenRatios = {
  recentChat: number;
  summary: number;
  retrieved: number;
  coreEpisodic: number;
};

export function getMemoryTokenRatios(intent: UserIntent = "general"): MemoryTokenRatios {
  if (intent === "story" || intent === "action") {
    return { recentChat: 0.4, summary: 0.15, retrieved: 0.05, coreEpisodic: 0.4 };
  }

  if (intent === "fact") {
    return { recentChat: 0.45, summary: 0.15, retrieved: 0.3, coreEpisodic: 0.1 };
  }

  return MEMORY_TOKEN_RATIOS;
}

export function trimTextToTokenLimit(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return "";
  if (countTokens(text) <= maxTokens) return text;

  let lo = 0;
  let hi = text.length;
  let best = "";

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const slice = text.slice(0, Math.max(0, mid));
    if (countTokens(slice) <= maxTokens) {
      best = slice;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best.trimEnd();
}

/** Whole lines in order: ranked Core keeps its most important facts and never a half-fact.
 * A heading is kept only together with a line under it. */
export function trimLinesToTokenLimit(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return "";
  if (countTokens(text) <= maxTokens) return text;
  const kept: string[] = [];
  let heading: string | null = null;
  for (const line of text.split("\n")) {
    if (/^#{1,3}\s/.test(line.trim()) || !line.trim()) { if (line.trim()) heading = line; continue; }
    const next = [...kept, ...(heading ? [...(kept.length ? [""] : []), heading] : []), line];
    if (countTokens(next.join("\n")) > maxTokens) break;
    kept.splice(0, kept.length, ...next);
    heading = null;
  }
  // A single fact larger than the allowance (a pasted note): its beginning beats nothing.
  return kept.length ? kept.join("\n") : trimTextToTokenLimit(text, maxTokens);
}

const SUMMARY_HEAD_SHARE = 0.35;
/**
 * Over its allowance a summary keeps its opening (how the story began) and its newest part and
 * drops whole sentences from the middle. Slicing the text cut the newest events mid-sentence.
 */
export function trimSummaryToTokenLimit(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return "";
  if (countTokens(text) <= maxTokens) return text;
  type Unit = { text: string; heading: boolean; lineStart: boolean };
  const units: Unit[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (/^#{1,3}\s/.test(line.trim())) { units.push({ text: line.trim(), heading: true, lineStart: true }); continue; }
    line.trim().split(/(?<=[.!?…])\s+/u).forEach((sentence, index) => units.push({ text: sentence, heading: false, lineStart: index === 0 }));
  }
  const gap: Unit = { text: "…", heading: false, lineStart: true };
  const render = (rows: Unit[]) => rows.map((row, index) => index === 0 ? row.text
    : `${row.heading ? "\n\n" : row.lineStart ? "\n" : " "}${row.text}`).join("");
  const head: Unit[] = [];
  for (const unit of units) {
    if (countTokens(render([...head, unit])) > maxTokens * SUMMARY_HEAD_SHARE) break;
    head.push(unit);
  }
  const tail: Unit[] = [];
  for (let index = units.length - 1; index >= head.length; index -= 1) {
    const candidate = [units[index], ...tail];
    // A heading in the dropped middle stays with the section it introduces.
    if (countTokens(render([...head, gap, ...candidate])) > maxTokens) break;
    tail.unshift(units[index]);
  }
  const middleHeading = [...units.slice(head.length, units.length - tail.length)].reverse().find(unit => unit.heading);
  const rows = [...head, gap, ...(middleHeading && tail[0] && !tail[0].heading ? [middleHeading] : []), ...tail];
  while (rows.length > head.length + 1 && countTokens(render(rows)) > maxTokens) rows.splice(head.length + 1, 1);
  return render(rows).trim();
}

export function allocateTokens(
  _messages: ChatCompletionMessage[],
  maxContextTokens: number,
  reservedTokens = 0,
  intent: UserIntent = "general"
) {
  const available = Math.max(0, maxContextTokens - reservedTokens);
  const ratios = getMemoryTokenRatios(intent);
  const recentChat = Math.floor(available * ratios.recentChat);
  const summary = Math.floor(available * ratios.summary);
  const retrieved = Math.floor(available * ratios.retrieved);
  const coreEpisodic = Math.max(0, available - recentChat - summary - retrieved);

  debugLog(
    "ContextStrategy",
    `intent=${intent} recent=${recentChat} summary=${summary} rag=${retrieved} episodic=${coreEpisodic} available=${available}`
  );

  return { available, recentChat, summary, retrieved, coreEpisodic };
}

export async function getOrCreateBaseModel(): Promise<EconomyModel> {
  let baseModel = await prisma.model.findFirst({
    where: { isActive: true, name: chatModelNameFilter(true) },
    orderBy: [{ priceVC: "asc" }, { createdAt: "asc" }],
    select: modelSelect,
  });

  if (!baseModel) {
    if (getChatProvider() === "deepinfra") throw new AiProviderConfigurationError();
    baseModel = await prisma.model.create({
      data: {
        name: "google/gemma-4-31b",
        displayName: "Gemma 4 31B",
        pricePer1MInput: 1.5,
        pricePer1MOutput: 6,
        priceVC: 4,
        maxContextTokens: 4000,
        isActive: true,
      },
      select: modelSelect,
    });
  }

  return { ...baseModel, isFreeForSubscribers: false };
}

/** Preview must never activate a subscription or create a fallback model. */
export async function resolveChatPreviewContext(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscriptionType: true, subscriptionEnd: true, selectedModel: { select: modelSelect } },
  });
  if (!user) return null;
  const selected = user.selectedModel;
  const model = selected?.isActive && availableChatModel(selected.name) ? selected
    : await prisma.model.findFirst({
      where: { isActive: true, name: chatModelNameFilter(true) },
      orderBy: [{ priceVC: "asc" }, { createdAt: "asc" }], select: modelSelect,
    });
  return model ? { user, model: { ...model, isFreeForSubscribers: false } } : null;
}

export async function resolveChatContext(userId: string) {
  const baseModel = await getOrCreateBaseModel();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      verseCoins: true,
      subscriptionType: true,
      subscriptionEnd: true,
      dailyRequests: true,
      dailyRequestsDate: true,
      createdAt: true,
      selectedModel: { select: modelSelect },
    },
  });

  if (!user) return null;

  const synced = await applyPendingSubscriptionIfDue(userId);
  const subscriptionType = synced?.subscriptionType ?? user.subscriptionType;
  const subscriptionEnd = synced?.subscriptionEnd ?? user.subscriptionEnd;

  let model = user.selectedModel;
  if (!model || !model.isActive || !availableChatModel(model.name)) {
    model = baseModel;
  }

  return {
    user: {
      ...user,
      subscriptionType,
      subscriptionEnd,
    },
    model: { ...model, isFreeForSubscribers: false },
    baseModel,
  };
}

type PrepareChatMessagesOptions = {
  scope: ChatScope;
  character: CharacterForChat;
  user: ChatUser;
  model: EconomyModel;
  apiKey: string;
  ragQueryText?: string;
  excludeMessageId?: string;
  continueMode?: boolean;
  continueCutOff?: boolean;
  historyBeforeMessageId?: string;
  intent?: UserIntent;
  locale?: string;
  refreshSummary?: boolean;
};

export type ContextAssemblyStats = {
  episodicShown: number;
  ragQuotes: number;
  historyMessages: number;
  unprocessedInWindow: number;
  droppedUnprocessed: number;
  droppedMemoryBlocks: MemoryBlockKind[];
  /** Blocks shortened to their allowance: an overflow that is otherwise invisible in the prompt. */
  trimmedMemoryBlocks: MemoryBlockKind[];
};

export type PreparedChatMessages = {
  messages: ChatCompletionMessage[];
  totalTokens: number;
  maxContextTokens: number;
  memorySummary: string | null;
  stats: ContextAssemblyStats;
};

export type ChatHistoryRow = {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
};

export type FastChatContext = {
  userId: string;
  systemPromptBase: string;
  memorySummary: string | null;
  /** createdAt of the last message proven to be in the summary; null = nothing covered. */
  summaryCoveredUntil: Date | null;
  memoryCandidates: MemoryCandidates;
  historyRows: ChatHistoryRow[];
  /** Strict regeneration cutoff, including when there are no preceding messages. */
  historyBefore?: Date | null;
  /** Exact tokens of the loaded window plus an average-based estimate for older messages. */
  totalHistoryTokens: number;
  ragEligible: boolean;
  maxContextTokens: number;
  historyLimit: number;
  subscriptionLogType: string;
  locale: string;
};

/** Prompt budget: plan limit, and never more than the model can take with room for the reply. */
export function resolveContextTokenBudget(
  user: Pick<ChatUser, "subscriptionType" | "subscriptionEnd">,
  model: Pick<EconomyModel, "maxContextTokens"> & { name?: string }
): number {
  const planLimit = getContextTokenLimit(user);
  const modelLimit = Number(model.maxContextTokens);
  const outputReserve = chatModelGenerationOptions(model.name ?? "").max_tokens;
  if (!Number.isFinite(modelLimit) || modelLimit <= outputReserve) return planLimit;
  return Math.min(planLimit, modelLimit - outputReserve);
}

export function estimateHistoryTokens(windowTokens: number, windowCount: number, olderCount: number): number {
  if (windowCount <= 0 || olderCount <= 0) return windowTokens;
  return windowTokens + Math.round((olderCount * windowTokens) / windowCount);
}

/**
 * Newest-first contiguous suffix of the window. Messages after the summary coverage
 * (inclusive of the boundary timestamp) are unprocessed and may use the extended budget;
 * covered messages only the base budget. The newest message is always kept.
 */
export function selectRecentHistory(
  rows: ChatHistoryRow[],
  coveredUntil: Date | null,
  budget: { base: number; extended: number },
  count: (text: string) => number = countTokens
): { rows: ChatHistoryRow[]; tokens: number; unprocessedInWindow: number; droppedUnprocessed: number } {
  const picked: ChatHistoryRow[] = [];
  let tokens = 0;
  let stopped = false;
  let unprocessedInWindow = 0;
  let droppedUnprocessed = 0;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const rowTokens = count(row.content);
    const unprocessed = !coveredUntil || row.createdAt.getTime() >= coveredUntil.getTime();
    if (unprocessed) unprocessedInWindow += 1;
    const limit = unprocessed ? budget.extended : budget.base;
    if (index === rows.length - 1 || (!stopped && tokens + rowTokens <= limit)) {
      picked.push(row);
      tokens += rowTokens;
    } else {
      stopped = true;
      if (unprocessed) droppedUnprocessed += 1;
    }
  }

  return { rows: picked.reverse(), tokens, unprocessedInWindow, droppedUnprocessed };
}

const CUT_OFF_CONJUNCTIONS = [
  "несмотря на",
  "в отличие от",
  "в связи с",
  "в результате",
  "в продолжение",
  "в заключение",
  "по прошествии",
  "на основании",
  "при помощи",
  "с помощью",
  "начиная с",
  "по причине",
  "в течение",
  "за счёт",
  "по мере",
  "из-за",
  "благодаря",
  "посредством",
  "потому что",
  "так как",
  "ввиду",
  "в силу",
  "сквозь",
  "вдоль",
  "напротив",
  "возле",
  "около",
  "подле",
  "среди",
  "между",
  "вокруг",
  "мимо",
  "кроме",
  "включая",
  "исключая",
  "кончая",
  "спустя",
  "чтобы",
  "когда",
  "хотя",
  "пока",
  "будто",
  "словно",
  "через",
  "если",
  "и",
  "но",
];

const CUT_OFF_CONJUNCTION_RE = new RegExp(
  `(?:^|\\s)(?:${CUT_OFF_CONJUNCTIONS.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*$`,
  "i"
);

function hasUnclosedQuotes(text: string): boolean {
  const guillemetOpen = (text.match(/«/g) ?? []).length;
  const guillemetClose = (text.match(/»/g) ?? []).length;
  if (guillemetOpen > guillemetClose) return true;

  const lowOpen = (text.match(/„/g) ?? []).length;
  const lowClose = (text.match(/[“”]/g) ?? []).length;
  if (lowOpen > lowClose) return true;

  return ((text.match(/"/g) ?? []).length) % 2 === 1;
}

function hasUnclosedParens(text: string): boolean {
  const open = (text.match(/\(/g) ?? []).length;
  const close = (text.match(/\)/g) ?? []).length;
  return open > close;
}

export function isAssistantMessageCutOff(
  content: string | null | undefined,
  finishReason?: string | null
): boolean {
  const text = content?.trim() ?? "";
  if (!text) return false;

  // Provider termination takes precedence over stylistic punctuation.
  if (finishReason === "length") return true;
  if (finishReason === "stop") return false;

  if (/\.\.\.\s*$/.test(text) || /…\s*$/.test(text)) {
    return true;
  }

  return (
    hasUnclosedQuotes(text) ||
    hasUnclosedParens(text) ||
    CUT_OFF_CONJUNCTION_RE.test(text) ||
    /[,;:]\s*$/.test(text) ||
    /[—–-]\s*$/.test(text) ||
    /[«"„][^«"“»"]*$/.test(text)
  );
}

export function replyHasActionOptions(content: string | null | undefined): boolean {
  const text = content?.trim() ?? "";
  if (!text) return false;

  const listed = (text.match(/^\s*(?:\d+[\).]|[-•*])\s+\S+/gm) ?? []).length;
  if (listed >= 3) return true;

  return /(?:варианты|ты можешь|можешь выбрать|что делать)/i.test(text) && listed >= 2;
}

export function logActionOptionsIfPresent(content: string | null | undefined): void {
  if (replyHasActionOptions(content)) {
    debugLog("Chat", "Предложены варианты действий");
  }
}

export function mergeAssistantContinuation(original: string, continuation: string): string {
  const left = original.trimEnd();
  const right = continuation.trim();
  if (!right) return left;

  const needsSpace = !/\s$/.test(left) && !/^[.,!?;:—…)»"”']/.test(right);
  return needsSpace ? `${left} ${right}` : `${left}${right}`;
}

async function loadChatHistoryRows({
  scope,
  historyLimit,
  historyBeforeMessageId,
}: {
  scope: ChatScope;
  historyLimit: number;
  historyBeforeMessageId?: string;
}): Promise<{ rows: ChatHistoryRow[]; olderCount: number; historyBefore: Date | null }> {
  let cutoff: Date | null = null;
  if (historyBeforeMessageId) {
    const cutoffMessage = await prisma.message.findUnique({
      where: { id: historyBeforeMessageId },
      select: { createdAt: true },
    });

    if (!cutoffMessage) {
      throw new Error("Сообщение для истории не найдено");
    }
    cutoff = cutoffMessage.createdAt;
  }

  const where = { ...messageScopeWhere(scope), ...(cutoff ? { createdAt: { lt: cutoff } } : {}) };
  const [rows, total] = await Promise.all([
    prisma.message.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: historyLimit,
      select: { id: true, role: true, content: true, createdAt: true },
    }),
    prisma.message.count({ where }),
  ]);
  return { rows: rows.reverse(), olderCount: Math.max(0, total - rows.length), historyBefore: cutoff };
}

/** Core (names, relationships, key facts) is never dropped: a 16k prompt without it lost the
 * names of everyone in a 196-message story (prod 2026-10-24). Events are cheaper than the summary. */
const DROP_ORDER_WHEN_OVER_LIMIT: MemoryBlockKind[] = ["quotes", "events", "summary"];
/** Share of the context that memory keeps even against a long unprocessed tail. */
const MEMORY_RESERVE_SHARE = 0.3;

export function assemblePreparedChatMessages(
  context: FastChatContext,
  intent: UserIntent = "general",
  ragMessages: RagMessage[] | null = null
): PreparedChatMessages {
  const { locale, maxContextTokens } = context;
  const allocations = allocateTokens([], maxContextTokens, countTokens(context.systemPromptBase), intent);

  // Episodic: pick by rank for the actual intent, keep what fits, show in story order.
  const coreText = context.memoryCandidates.core
    ? trimLinesToTokenLimit(context.memoryCandidates.core, allocations.coreEpisodic)
    : "";
  let episodicRoom = allocations.coreEpisodic - countTokens(coreText);
  const keptEvents: EpisodicMemoryItem[] = [];
  const query = [...context.historyRows].reverse().find((row) => row.role === "user")?.content ?? "";
  // Event lifecycle: trivial quotes never take a line, and an ordinary event the summary already
  // retells gives its line to newer ones unless it is important or about the current message.
  const covered = context.summaryCoveredUntil?.getTime();
  const liveEvents = context.memoryCandidates.episodic.filter(item => !isTrivialEvent(item.event)
    && (item.importance >= 3 || covered === undefined || item.timestamp.getTime() > covered || memoryOverlap(query, item.event) >= 0.5));
  for (const item of rankEpisodicCandidates(liveEvents, query).slice(0, episodicLimitForIntent(intent))) {
    const itemTokens = countTokens(formatEpisodicLine(item)) + 1;
    if (itemTokens > episodicRoom) continue;
    keptEvents.push(item);
    episodicRoom -= itemTokens;
  }
  const eventsText = sortEpisodicChronologically(keptEvents).map(formatEpisodicLine).join("\n");
  const summaryText = context.memorySummary ? trimSummaryToTokenLimit(context.memorySummary, allocations.summary) : "";
  const quotesOutside = (recentIds: Set<string>) =>
    fitRagExcerpts(ragMessages ?? [], recentIds, allocations.retrieved, countTokens, locale);
  const dropped = new Set<MemoryBlockKind>();
  const compose = (quotes: Array<{ line: string }>) => {
    const blocks: MemoryBlock[] = [
      { kind: "core", body: coreText },
      { kind: "events", body: eventsText },
      { kind: "summary", body: summaryText },
      { kind: "quotes", body: quotes.map((quote) => quote.line).join("\n") },
    ];
    return appendMemorySection(context.systemPromptBase, blocks.filter((block) => !dropped.has(block.kind)), locale);
  };
  const rows = context.historyRows;
  const coverage = context.summaryCoveredUntil;

  // Unprocessed messages have no dependable replacement in stored memory. Pin the contiguous
  // suffix, then shed old memory before it. The suffix may not take memory's reserve: an
  // unbounded tail evicted every memory block once coverage fell behind. Rows beyond it are
  // reported as dropped; the timestamp never pretends that they were summarized.
  const baseTokens = countTokens(context.systemPromptBase);
  const memoryTokens = countTokens(compose(quotesOutside(new Set()))) - baseTokens;
  const memoryReserve = Math.min(Math.max(0, memoryTokens), Math.floor(maxContextTokens * MEMORY_RESERVE_SHARE));
  const protectedTail = selectRecentHistory(rows, coverage, {
    base: 0,
    extended: Math.max(0, maxContextTokens - baseTokens - memoryReserve),
  });
  let quotes = quotesOutside(new Set(protectedTail.rows.map((row) => row.id)));
  let systemPrompt = compose(quotes);
  let systemTokens = countTokens(systemPrompt);
  for (const kind of DROP_ORDER_WHEN_OVER_LIMIT) {
    if (systemTokens + protectedTail.tokens <= maxContextTokens) break;
    dropped.add(kind);
    systemPrompt = compose(quotes);
    systemTokens = countTokens(systemPrompt);
  }

  // Covered history has its regular share. The pinned tail can use every remaining
  // token, rather than disappearing just because old memory filled its allocation.
  const capB = Math.max(0, maxContextTokens - systemTokens);
  const recent = selectRecentHistory(rows, coverage, {
    base: Math.min(allocations.recentChat, capB),
    extended: capB,
  });
  const recentIds = new Set(recent.rows.map((row) => row.id));
  if (quotes.some(quote => quote.messages.some(message => recentIds.has(message.id)))) {
    quotes = excludeRecentRagSources(quotes, recentIds, locale);
    systemPrompt = compose(quotes);
    systemTokens = countTokens(systemPrompt);
  }

  const messages: ChatCompletionMessage[] = [
    { role: "system", content: systemPrompt },
    ...recent.rows.map((row) => ({
      role: (row.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: row.content,
    })),
  ];
  const totalTokens = systemTokens + recent.tokens;
  const stats: ContextAssemblyStats = {
    episodicShown: dropped.has("events") ? 0 : keptEvents.length,
    ragQuotes: dropped.has("quotes") ? 0 : quotes.reduce((sum, quote) => sum + quote.messages.length, 0),
    historyMessages: recent.rows.length,
    unprocessedInWindow: recent.unprocessedInWindow,
    droppedUnprocessed: recent.droppedUnprocessed,
    droppedMemoryBlocks: [...dropped],
    trimmedMemoryBlocks: [...(coreText !== (context.memoryCandidates.core ?? "") ? ["core" as const] : []),
      ...(summaryText !== (context.memorySummary ?? "") ? ["summary" as const] : [])],
  };

  debugLog(
    "Chat",
    `Загружено ${rows.length} сообщений для подписки ${context.subscriptionLogType} (лимит: ${context.historyLimit}, контекст: ${maxContextTokens})`
  );
  debugLog(
    "Chat",
    `Отправлено ${messages.length} сообщений user=${context.userId} (токенов: ${totalTokens}, лимит: ${maxContextTokens}) episodic=${stats.episodicShown} rag=${stats.ragQuotes} unprocessed=${stats.unprocessedInWindow} droppedUnprocessed=${stats.droppedUnprocessed}${stats.droppedMemoryBlocks.length ? ` droppedBlocks=${stats.droppedMemoryBlocks.join(",")}` : ""}${stats.trimmedMemoryBlocks.length ? ` trimmedBlocks=${stats.trimmedMemoryBlocks.join(",")}` : ""}`
  );
  if (totalTokens > maxContextTokens) {
    errorLog("Chat", `Контекст превышает лимит даже без памяти: ${totalTokens}/${maxContextTokens}`);
  }

  return { messages, totalTokens, maxContextTokens, memorySummary: context.memorySummary, stats };
}

export async function prepareFastContext({
  scope,
  character,
  user,
  apiKey,
  ragQueryText,
  continueMode = false,
  continueCutOff = false,
  historyBeforeMessageId,
  model,
  locale = "ru",
  refreshSummary = false,
}: PrepareChatMessagesOptions): Promise<FastChatContext> {
  const { userId, characterId } = scope;
  const subscriptionActive = isSubscriptionActive(user);
  const maxContextTokens = resolveContextTokenBudget(user, model);
  const ragEligible = isRagEligible(user.subscriptionType, subscriptionActive);
  const historyLimit = getHistoryMessageLimit(user.subscriptionType, subscriptionActive);
  const subscriptionLogType = subscriptionActive ? user.subscriptionType ?? "unknown" : "start";

  // Candidates are intent-independent; the final pick happens in assemblePreparedChatMessages.
  const [memoryState, memoryCandidates, selectedPersona, history] = await Promise.all([
    refreshSummary
      ? resolveChatMemorySummary(scope, apiKey, user)
          .catch((error) => errorLog("Memory", "summary refresh failed, using stored summary", toSafeDiagnostic(error)))
          .then(() => readChatMemoryState(scope))
      : readChatMemoryState(scope),
    loadMemoryCandidates(scope, maxContextTokens, ragQueryText),
    getSelectedChatPersona(userId, characterId, scope.threadId),
    loadChatHistoryRows({ scope, historyLimit, historyBeforeMessageId }),
  ]);
  const historyRows = history.rows;

  const promptState = await getOrCreateThreadPromptState(scope);
  const assembly = resolveChatPromptAssembly(character, locale, promptState, {
    persona: selectedPersona, operation: continueMode ? "continue" : historyBeforeMessageId ? "regenerate" : "reply", cutOff: continueCutOff,
    tokenBudget: Math.floor(maxContextTokens * 0.5),
  });
  infoLog("PromptAssembly", JSON.stringify({ characterId, userId, ...promptAssemblyDiagnostics(assembly) }));
  const systemPromptBase = assembly.content;
  if (selectedPersona) {
    debugLog("Persona", `prompt user=${userId} character=${characterId} persona=${selectedPersona.id}`);
  }

  const windowTokens = historyRows.reduce((sum, msg) => sum + countTokens(msg.content), 0);
  const totalHistoryTokens = estimateHistoryTokens(windowTokens, historyRows.length, history.olderCount);

  return {
    userId,
    systemPromptBase,
    memorySummary: memoryState.summary,
    summaryCoveredUntil: memoryState.coveredUntil,
    memoryCandidates,
    historyRows,
    historyBefore: history.historyBefore,
    totalHistoryTokens,
    ragEligible,
    maxContextTokens,
    historyLimit,
    subscriptionLogType,
    locale,
  };
}

export async function searchRagContext({
  scope,
  apiKey,
  ragQueryText,
  excludeMessageId,
  intent,
  ragEligible,
  totalHistoryTokens,
  historyRows = [],
  historyBefore,
}: {
  scope: ChatScope;
  apiKey: string;
  ragQueryText?: string;
  excludeMessageId?: string;
  intent: UserIntent;
  ragEligible: boolean;
  totalHistoryTokens: number;
  historyRows?: ChatHistoryRow[];
  historyBefore?: Date | null;
}): Promise<RagMessage[]> {
  const ragDecision = shouldUseRag({
    ragEligible,
    userQuery: ragQueryText,
    intent,
    historyTokens: totalHistoryTokens,
  });
  debugLog(
    "RAGDecision",
    `use=${ragDecision.use ? "yes" : "no"} reason=${ragDecision.reason} tokens=${totalHistoryTokens} intent=${intent}`
  );

  if (!ragDecision.use || !ragQueryText) {
    return [];
  }

  try {
    const queryHistory = limitRagHistoryToQuery(historyRows, excludeMessageId);
    const query = buildRagSearchQuery(ragQueryText, queryHistory, excludeMessageId);
    const ragMessages = await searchRelevantMessages(
      scope,
      query,
      apiKey,
      excludeMessageId,
      undefined,
      undefined,
      { currentQuery: ragQueryText, excludedMessageIds: queryHistory.slice(-3).map(row => row.id), throughMessage: queryHistory.at(-1), before: historyBefore }
    );
    debugLog("RAG", `найдено ${ragMessages.length} релевантных сообщений`);
    return ragMessages;
  } catch (ragError) {
    errorLog("RAG", "ошибка поиска релевантных сообщений", toSafeDiagnostic(ragError));
    return [];
  }
}

export async function prepareChatMessages(options: PrepareChatMessagesOptions): Promise<PreparedChatMessages> {
  const intent = options.intent ?? "general";
  const fastContext = await prepareFastContext({ ...options, refreshSummary: options.refreshSummary ?? true });
  const ragMessages = await searchRagContext({
    scope: options.scope,
    apiKey: options.apiKey,
    ragQueryText: options.ragQueryText,
    excludeMessageId: options.excludeMessageId,
    intent,
    ragEligible: fastContext.ragEligible,
    totalHistoryTokens: fastContext.totalHistoryTokens,
    historyRows: fastContext.historyRows,
    historyBefore: fastContext.historyBefore,
  });
  return assemblePreparedChatMessages(fastContext, intent, ragMessages);
}

// Provider-neutral: the chat may run on KodikRouter or DeepInfra.
function logChatRetry(attempt: number, error: unknown) {
  errorLog("ChatDiagnostics", "retry scheduled", { ...aiCostDiagnosticContext(),
    stage: "before_stream_retry", retryAttempt: attempt }, toSafeDiagnostic(error));
}

export async function callChatCompletion(
  modelName: string,
  messages: ChatCompletionMessage[],
  apiKey: string
): Promise<string> {
  const route = chatTransport(modelName, apiKey);
  logPromptDelivery(modelName, messages, false);
  return retryWithBackoff(
    async () => {
      const response = await meteredPost("chat",
        route.url,
        {
          model: route.model,
          messages,
          ...chatModelGenerationOptions(modelName),
        },
        {
          headers: {
            Authorization: `Bearer ${route.apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: chatModelRequestTimeoutMs(modelName),
        }
      );

      const reply = response.data.choices[0]?.message?.content?.trim() ?? "";
      if (!reply) {
        throw new Error("Пустой ответ от ИИ");
      }

      return reply;
    },
    {
      maxAttempts: 3,
      onRetry: logChatRetry,
    }
  );
}

type ChatStreamTimeoutStage = "first_byte" | "idle" | "total";

/** Named TimeoutError so a first-byte timeout is retried and the user sees a timeout message. */
export class ChatStreamTimeoutError extends Error {
  readonly stage: ChatStreamTimeoutStage;
  constructor(stage: ChatStreamTimeoutStage) {
    super("Модель не ответила вовремя");
    this.name = "TimeoutError";
    this.stage = stage;
  }
}

export async function streamChatCompletion(
  modelName: string,
  messages: ChatCompletionMessage[],
  apiKey: string
): Promise<ReadableStream<Uint8Array>> {
  const route = chatTransport(modelName, apiKey);
  logPromptDelivery(modelName, messages, true);
  const limits = chatModelStreamTimeouts(modelName);
  return retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const abortWith = (stage: ChatStreamTimeoutStage) => controller.abort(new ChatStreamTimeoutError(stage));
      const unref = (timer: ReturnType<typeof setTimeout>) => { timer.unref?.(); return timer; };
      // Before headers a timeout is retried; after them the reply is already streaming to the user.
      const firstByte = unref(setTimeout(() => abortWith("first_byte"), limits.firstByteMs));
      const total = unref(setTimeout(() => abortWith("total"), limits.totalMs));
      let idle: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        clearTimeout(idle);
        idle = unref(setTimeout(() => abortWith("idle"), limits.idleMs));
      };
      const stopTimers = () => {
        clearTimeout(firstByte);
        clearTimeout(total);
        clearTimeout(idle);
      };
      let response: Response;
      try {
        response = await meteredChatFetch(route.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${route.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: route.model,
            messages,
            ...chatModelGenerationOptions(modelName),
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: controller.signal,
        }, route.model, Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4), stopTimers, armIdle, limits);
      } catch (error) {
        stopTimers();
        throw error;
      }
      clearTimeout(firstByte);
      armIdle();

      if (!response.ok) {
        stopTimers();
        await response.body?.cancel().catch(() => {});
        const error = new Error(
          `Ошибка стриминга ИИ: ${response.status}`
        ) as Error & { status: number };
        error.status = response.status;
        throw error;
      }

      if (!response.body) {
        stopTimers();
        throw new Error("Пустой поток ответа от ИИ");
      }

      return response.body;
    },
    {
      // One quick retry: with a 15 s first-byte limit the worst wait is about 31 s, not 3 minutes.
      maxAttempts: 2,
      shouldRetry: (error) => {
        if ((error as { __noRetry?: boolean }).__noRetry) return false;
        return defaultShouldRetry(error);
      },
      onRetry: logChatRetry,
    }
  );
}

export type ChatChargeReservation =
  | { ok: false; balance: number; freeQuota: FreeQuotaState | null }
  | {
      ok: true;
      /** VC actually debited: 0 when the free daily quota covered the reply. */
      chargedVC: number;
      remainingVC: number;
      freeQuota: FreeQuotaState | null;
      refund: () => Promise<void>;
    };

/**
 * Debits the request cost before generation. The user row is locked, so parallel
 * requests cannot each pass the balance check (or share the last free reply) and a
 * concurrent grant is never overwritten. Callers must refund() if the reply is not stored.
 */
export async function reserveChatCharge({
  userId,
  costVC,
  freeQuotaEligible = false,
  characterName,
  modelDisplayName,
}: {
  userId: string;
  /** The model price; the free quota, when eligible and not used up, replaces it with 0. */
  costVC: number;
  freeQuotaEligible?: boolean;
  characterName: string;
  modelDisplayName: string;
}): Promise<ChatChargeReservation> {
  const refundContext = aiCostDiagnosticContext();
  const reservedAt = new Date();
  const reserved = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{
      verseCoins: number;
      permanentCoins: number | null;
      dailyRequests: number;
      dailyRequestsDate: Date;
      createdAt: Date;
      subscriptionType: string | null;
      subscriptionEnd: Date | null;
    }[]>`
      SELECT "verseCoins", "permanentCoins", "dailyRequests", "dailyRequestsDate", "createdAt", "subscriptionType", "subscriptionEnd"
      FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const current = rows[0];
    if (!current) {
      throw new Error("Пользователь не найден");
    }
    const quota = freeQuotaEligible && costVC > 0 ? getFreeQuotaState(current, reservedAt) : null;
    if (quota && quota.remaining > 0) {
      await tx.user.update({
        where: { id: userId },
        data: { dailyRequests: quota.used + 1, dailyRequestsDate: reservedAt },
      });
      const transaction = await tx.transaction.create({
        data: {
          userId,
          amount: 0,
          type: FREE_CHAT_TRANSACTION_TYPE,
          description: `Чат: ${characterName}, модель ${modelDisplayName} (бесплатно)`,
        },
        select: { id: true },
      });
      return {
        ok: true as const,
        chargedVC: 0,
        remainingVC: current.verseCoins,
        fromPermanent: 0,
        transactionId: transaction.id,
        freeQuota: { ...quota, used: quota.used + 1, remaining: quota.remaining - 1 },
      };
    }
    if (costVC <= 0) {
      return { ok: true as const, chargedVC: 0, remainingVC: current.verseCoins, fromPermanent: 0, transactionId: null, freeQuota: quota };
    }
    if (current.verseCoins < costVC) {
      return { ok: false as const, balance: current.verseCoins, freeQuota: quota };
    }

    const nextCoins = spendCoins(current, costVC);
    await tx.user.update({
      where: { id: userId },
      data: { verseCoins: nextCoins.verseCoins, permanentCoins: nextCoins.permanentCoins },
    });
    const transaction = await tx.transaction.create({
      data: {
        userId,
        amount: -costVC,
        type: "chat",
        description: `Чат: ${characterName}, модель ${modelDisplayName}`,
      },
      select: { id: true },
    });
    return {
      ok: true as const,
      chargedVC: costVC,
      remainingVC: nextCoins.verseCoins,
      fromPermanent: getPermanentCoins(current) - nextCoins.permanentCoins,
      transactionId: transaction.id,
      freeQuota: quota,
    };
  });

  if (reserved.ok === false) {
    return reserved;
  }

  const { chargedVC, transactionId } = reserved;
  const freeReply = chargedVC === 0 && reserved.freeQuota !== null && transactionId !== null;
  debugLog("Chat", freeReply
    ? `Бесплатный ответ ${reserved.freeQuota!.used}/${reserved.freeQuota!.limit} user=${userId}`
    : `Зарезервировано ${chargedVC} VC user=${userId}, осталось ${reserved.remainingVC} VC`);

  let refunded = false;
  const refund = async () => {
    if (refunded || !transactionId) return;
    refunded = true;
    try {
      if (freeReply) {
        await prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ dailyRequests: number; dailyRequestsDate: Date }[]>`
            SELECT "dailyRequests", "dailyRequestsDate" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
          const current = rows[0];
          // After Moscow midnight the counter already restarted; there is nothing to give back.
          if (current && current.dailyRequests > 0 && isSameMoscowDay(current.dailyRequestsDate, reservedAt)) {
            await tx.user.update({ where: { id: userId }, data: { dailyRequests: { decrement: 1 } } });
          }
          await tx.transaction.delete({ where: { id: transactionId } });
        });
      } else {
        await prisma.$transaction([
          prisma.user.update({
            where: { id: userId },
            data: {
              verseCoins: { increment: chargedVC },
              permanentCoins: { increment: reserved.fromPermanent },
            },
          }),
          prisma.transaction.delete({ where: { id: transactionId } }),
        ]);
      }
      debugLog("Chat", freeReply
        ? `Возвращён бесплатный ответ user=${userId}: ответ не сохранён`
        : `Возвращено ${chargedVC} VC user=${userId}: ответ не сохранён`);
      infoLog("ChatRefund", "refund completed", { ...refundContext, transactionId,
        costVC: chargedVC, freeReply, refundStatus: "completed" });
    } catch (error) {
      errorLog("ChatRefund", "refund failed", toSafeDiagnostic(error), { ...refundContext,
        transactionId, costVC: chargedVC, freeReply, refundStatus: "failed" });
    }
  };

  return { ok: true, chargedVC, remainingVC: reserved.remainingVC, freeQuota: reserved.freeQuota, refund };
}

export function buildChatResponsePayload({
  costVC,
  remainingVC,
  freeQuota = null,
  model,
  greetingMessage,
  userMessage,
  assistantMessage,
}: {
  costVC: number;
  remainingVC: number;
  freeQuota?: FreeQuotaState | null;
  model: EconomyModel;
  greetingMessage?: { id: string; role: string; content: string; createdAt: Date };
  userMessage?: { id: string; role: string; content: string; createdAt: Date };
  assistantMessage: { id: string; role: string; content: string; createdAt: Date };
}) {
  return {
    ...(greetingMessage ? { greetingMessage } : {}),
    ...(userMessage ? { userMessage } : {}),
    assistantMessage,
    model: {
      id: model.id,
      displayName: model.displayName,
    },
    chargedVC: costVC,
    remainingVC,
    isFree: costVC === 0,
    chargedCoins: costVC,
    remainingCoins: remainingVC,
    ...(freeQuota ? { freeQuota } : {}),
  };
}
