import { meteredPost, meteredChatFetch } from "@/lib/aiCostTelemetry";
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
import { appendPersonaToSystemPrompt } from "@/lib/persona";
import { getSelectedChatPersona } from "@/lib/personaService";
import { buildChatSystemPrompt } from "@/lib/chatSystemPrompt";
import { readChatMemoryState, resolveChatMemorySummary } from "@/lib/chatMemory";
import { appendMemorySection, type MemoryBlock, type MemoryBlockKind } from "@/lib/memoryPromptFormat";
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
import { spendCoins } from "@/lib/verseCoins";
import { debugLog, errorLog , toSafeDiagnostic} from "@/lib/logger";
import { retryWithBackoff, defaultShouldRetry } from "@/lib/retryWithBackoff";
import { chatModelGenerationOptions, chatModelRequestTimeoutMs, TESTING_CHAT_MODEL_NAMES } from "@/lib/testingChatModels";

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
  systemPrompt?: string | null;
};

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
  locale: string | null | undefined
): string {
  const stored = character.systemPrompt?.trim();
  if (stored) {
    debugLog("Chat", `Using stored systemPrompt character=${character.id}`);
    return stored;
  }
  debugLog("Chat", `Fallback buildChatSystemPrompt character=${character.id}`);
  return buildChatSystemPrompt(localizeCharacterForChat(character, locale), locale);
}

export type ChatUser = {
  id: string;
  verseCoins: number;
  subscriptionType: string | null;
  subscriptionEnd: Date | null;
  dailyRequests: number;
  dailyRequestsDate: Date;
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
    where: { isActive: true, name: { notIn: TESTING_CHAT_MODEL_NAMES } },
    orderBy: [{ priceVC: "asc" }, { createdAt: "asc" }],
    select: modelSelect,
  });

  if (!baseModel) {
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
      selectedModel: { select: modelSelect },
    },
  });

  if (!user) return null;

  const synced = await applyPendingSubscriptionIfDue(userId);
  const subscriptionType = synced?.subscriptionType ?? user.subscriptionType;
  const subscriptionEnd = synced?.subscriptionEnd ?? user.subscriptionEnd;

  let model = user.selectedModel;
  if (!model || !model.isActive) {
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
  userId: string;
  characterId: string;
  character: CharacterForChat;
  user: ChatUser;
  model: EconomyModel;
  apiKey: string;
  ragQueryText?: string;
  excludeMessageId?: string;
  continueMode?: boolean;
  continueCutOff?: boolean;
  continueSourceText?: string;
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
  userId,
  characterId,
  historyLimit,
  historyBeforeMessageId,
}: {
  userId: string;
  characterId: string;
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

  const where = { characterId, userId, ...(cutoff ? { createdAt: { lt: cutoff } } : {}) };
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

const DROP_ORDER_WHEN_OVER_LIMIT: MemoryBlockKind[] = ["quotes", "summary", "events", "core"];

export function assemblePreparedChatMessages(
  context: FastChatContext,
  intent: UserIntent = "general",
  ragMessages: RagMessage[] | null = null
): PreparedChatMessages {
  const { locale, maxContextTokens } = context;
  const allocations = allocateTokens([], maxContextTokens, countTokens(context.systemPromptBase), intent);

  // Episodic: pick by rank for the actual intent, keep what fits, show in story order.
  const coreText = context.memoryCandidates.core
    ? trimTextToTokenLimit(context.memoryCandidates.core, allocations.coreEpisodic)
    : "";
  let episodicRoom = allocations.coreEpisodic - countTokens(coreText);
  const keptEvents: EpisodicMemoryItem[] = [];
  const query = [...context.historyRows].reverse().find((row) => row.role === "user")?.content ?? "";
  for (const item of rankEpisodicCandidates(context.memoryCandidates.episodic, query).slice(0, episodicLimitForIntent(intent))) {
    const itemTokens = countTokens(formatEpisodicLine(item)) + 1;
    if (itemTokens > episodicRoom) continue;
    keptEvents.push(item);
    episodicRoom -= itemTokens;
  }
  const eventsText = sortEpisodicChronologically(keptEvents).map(formatEpisodicLine).join("\n");
  const summaryText = context.memorySummary ? trimTextToTokenLimit(context.memorySummary, allocations.summary) : "";
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

  // Unprocessed messages have no dependable replacement in stored memory. Pin the
  // contiguous suffix that fits with the base prompt, then shed old memory before it.
  // If that suffix itself exceeds the budget, retain the newest messages and report
  // the dropped rows; the timestamp never pretends that they were summarized.
  const protectedTail = selectRecentHistory(rows, coverage, {
    base: 0,
    extended: Math.max(0, maxContextTokens - countTokens(context.systemPromptBase)),
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
  };

  debugLog(
    "Chat",
    `Загружено ${rows.length} сообщений для подписки ${context.subscriptionLogType} (лимит: ${context.historyLimit}, контекст: ${maxContextTokens})`
  );
  debugLog(
    "Chat",
    `Отправлено ${messages.length} сообщений user=${context.userId} (токенов: ${totalTokens}, лимит: ${maxContextTokens}) episodic=${stats.episodicShown} rag=${stats.ragQuotes} unprocessed=${stats.unprocessedInWindow} droppedUnprocessed=${stats.droppedUnprocessed}${stats.droppedMemoryBlocks.length ? ` droppedBlocks=${stats.droppedMemoryBlocks.join(",")}` : ""}`
  );
  if (totalTokens > maxContextTokens) {
    errorLog("Chat", `Контекст превышает лимит даже без памяти: ${totalTokens}/${maxContextTokens}`);
  }

  return { messages, totalTokens, maxContextTokens, memorySummary: context.memorySummary, stats };
}

export async function prepareFastContext({
  userId,
  characterId,
  character,
  user,
  apiKey,
  continueMode = false,
  continueCutOff = false,
  continueSourceText,
  historyBeforeMessageId,
  model,
  locale = "ru",
  refreshSummary = false,
}: PrepareChatMessagesOptions): Promise<FastChatContext> {
  const subscriptionActive = isSubscriptionActive(user);
  const maxContextTokens = resolveContextTokenBudget(user, model);
  const ragEligible = isRagEligible(user.subscriptionType, subscriptionActive);
  const historyLimit = getHistoryMessageLimit(user.subscriptionType, subscriptionActive);
  const subscriptionLogType = subscriptionActive ? user.subscriptionType ?? "unknown" : "start";

  // Candidates are intent-independent; the final pick happens in assemblePreparedChatMessages.
  const [memoryState, memoryCandidates, selectedPersona, history] = await Promise.all([
    refreshSummary
      ? resolveChatMemorySummary(userId, characterId, apiKey, user)
          .catch((error) => errorLog("Memory", "summary refresh failed, using stored summary", toSafeDiagnostic(error)))
          .then(() => readChatMemoryState(userId, characterId))
      : readChatMemoryState(userId, characterId),
    loadMemoryCandidates(userId, characterId, maxContextTokens),
    getSelectedChatPersona(userId, characterId),
    loadChatHistoryRows({ userId, characterId, historyLimit, historyBeforeMessageId }),
  ]);
  const historyRows = history.rows;

  let systemPromptBase = appendPersonaToSystemPrompt(
    resolveChatSystemPrompt(character, locale),
    selectedPersona,
    locale
  );
  if (selectedPersona) {
    debugLog("Persona", `prompt user=${userId} character=${characterId} persona=${selectedPersona.id}`);
  }

  if (continueMode) {
    const english = locale === "en";
    if (continueCutOff && continueSourceText?.trim()) {
      systemPromptBase = english
        ? `Attention: you must continue the previous assistant message that was cut off. Here is the text to continue:
"${continueSourceText.trim()}"
Continue exactly from where it stopped. Do not repeat what was already written, and do not start over. Just write the missing part.

${systemPromptBase}`
        : `Внимание: ты должен продолжить предыдущее сообщение ассистента, которое было оборвано. Вот текст, который нужно продолжить:
«${continueSourceText.trim()}»
Продолжи ровно с того места, где остановился, не повторяй предыдущее, не начинай заново. Просто допиши недостающую часть.

${systemPromptBase}`;
    } else {
      systemPromptBase = english
        ? `${systemPromptBase}\n\nContinue your reply from where you left off.`
        : `${systemPromptBase}\n\nПродолжи ответ с того места, где остановился.`;
    }
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
  userId,
  characterId,
  apiKey,
  ragQueryText,
  excludeMessageId,
  intent,
  ragEligible,
  totalHistoryTokens,
  historyRows = [],
  historyBefore,
}: {
  userId: string;
  characterId: string;
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
      userId,
      characterId,
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
    userId: options.userId,
    characterId: options.characterId,
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

function logKodikRetry(attempt: number, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  errorLog("Server", "src/lib/chatHelpers.ts", toSafeDiagnostic(`[Chat] KodikRouter retry #${attempt}`), toSafeDiagnostic(message));
  errorLog("Server", "src/lib/chatHelpers.ts", toSafeDiagnostic(`[Chat] Attempt ${attempt}/3 failed, retrying...`));
}

export async function callChatCompletion(
  modelName: string,
  messages: ChatCompletionMessage[],
  apiKey: string
): Promise<string> {
  return retryWithBackoff(
    async () => {
      const response = await meteredPost("chat",
        `${KODIKROUTER_URL}/chat/completions`,
        {
          model: modelName,
          messages,
          ...chatModelGenerationOptions(modelName),
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
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
      onRetry: logKodikRetry,
    }
  );
}

export async function streamChatCompletion(
  modelName: string,
  messages: ChatCompletionMessage[],
  apiKey: string
): Promise<ReadableStream<Uint8Array>> {
  return retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), chatModelRequestTimeoutMs(modelName));
      let response: Response;
      try {
        response = await meteredChatFetch(`${KODIKROUTER_URL}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelName,
            messages,
            ...chatModelGenerationOptions(modelName),
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: controller.signal,
        }, modelName, Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4));
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const details = await response.text().catch(() => "");
        const error = new Error(
          `Ошибка стриминга ИИ: ${response.status}${details ? ` ${details.slice(0, 300)}` : ""}`
        ) as Error & { status: number };
        error.status = response.status;
        throw error;
      }

      if (!response.body) {
        throw new Error("Пустой поток ответа от ИИ");
      }

      return response.body;
    },
    {
      maxAttempts: 3,
      shouldRetry: (error) => {
        if ((error as { __noRetry?: boolean }).__noRetry) return false;
        return defaultShouldRetry(error);
      },
      onRetry: logKodikRetry,
    }
  );
}

export async function chargeForChatRequest({
  userId,
  costVC,
  characterName,
  modelDisplayName,
}: {
  userId: string;
  costVC: number;
  characterName: string;
  modelDisplayName: string;
}) {
  const updatedUser = await prisma.$transaction(async (tx) => {
    const current = await tx.user.findUnique({
      where: { id: userId },
      select: { verseCoins: true, permanentCoins: true },
    });

    if (!current) {
      throw new Error("Пользователь не найден");
    }

    const nextCoins =
      costVC > 0
        ? spendCoins(
            { verseCoins: current.verseCoins, permanentCoins: current.permanentCoins },
            costVC
          )
        : current;

    return tx.user.update({
      where: { id: userId },
      data: {
        verseCoins: nextCoins.verseCoins,
        permanentCoins: nextCoins.permanentCoins,
      },
      select: { verseCoins: true, permanentCoins: true },
    });
  });

  if (costVC > 0) {
    await prisma.transaction.create({
      data: {
        userId,
        amount: -costVC,
        type: "chat",
        description: `Чат: ${characterName}, модель ${modelDisplayName}`,
      },
    });
  }

  debugLog(
    "Chat",
    `После отправки user=${userId} осталось ${updatedUser.verseCoins} VC (списано ${costVC})`
  );

  return {
    remainingVC: updatedUser.verseCoins,
  };
}

export function buildChatResponsePayload({
  costVC,
  remainingVC,
  model,
  greetingMessage,
  userMessage,
  assistantMessage,
}: {
  costVC: number;
  remainingVC: number;
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
  };
}
