import axios from "axios";
import { encoding_for_model } from "tiktoken";
import { prisma } from "@/lib/prisma";
import { getRelevantMemories } from "@/lib/advancedMemory";
import { appendPersonaToSystemPrompt } from "@/lib/persona";
import { getSelectedChatPersona } from "@/lib/personaService";
import { buildChatSystemPrompt } from "@/lib/chatSystemPrompt";
import { appendMemoryToSystemPrompt, resolveChatMemorySummary } from "@/lib/chatMemory";
import type { UserIntent } from "@/lib/intentAnalyzer";
import {
  appendRagToSystemPrompt,
  formatRagContext,
  isRagEligible,
  RAG_HISTORY_TOKEN_THRESHOLD,
  searchRelevantMessages,
} from "@/lib/messageEmbeddings";
import { appendRandomEventToPrompt, pickRandomSceneEvent } from "@/lib/randomEvent";
import {
  DAILY_REQUEST_LIMIT,
  getContextTokenLimit,
  getDailyLimitWarning,
  getHistoryMessageLimit,
  isSubscriptionActive,
  normalizeUserCounters,
  type EconomyModel,
} from "@/lib/verseChatEconomy";
import { applyPendingSubscriptionIfDue } from "@/lib/subscriptionState";

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
};

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

export function countTokens(text: string): number {
  try {
    const enc = encoding_for_model("gpt-4");
    const tokens = enc.encode(text);
    enc.free();
    return tokens.length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

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
  reservedTokens = 0
) {
  const available = Math.max(0, maxContextTokens - reservedTokens);
  const recentChat = Math.floor(available * MEMORY_TOKEN_RATIOS.recentChat);
  const summary = Math.floor(available * MEMORY_TOKEN_RATIOS.summary);
  const retrieved = Math.floor(available * MEMORY_TOKEN_RATIOS.retrieved);
  const coreEpisodic = Math.max(0, available - recentChat - summary - retrieved);

  console.log(
    `[MemoryAlloc] max=${maxContextTokens} reserved=${reservedTokens} available=${available} recent=${recentChat} summary=${summary} retrieved=${retrieved} coreEpisodic=${coreEpisodic}`
  );

  return { available, recentChat, summary, retrieved, coreEpisodic };
}

export async function getOrCreateBaseModel(): Promise<EconomyModel> {
  let baseModel = await prisma.model.findFirst({
    where: { isActive: true },
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
};

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

export function isAssistantMessageCutOff(content: string | null | undefined): boolean {
  const text = content?.trim() ?? "";
  if (!text) return false;

  if (/\.\.\.\s*$/.test(text) || /…\s*$/.test(text)) {
    return true;
  }

  if (/[.!?][»"”']?\s*$/.test(text)) {
    return false;
  }

  return (
    hasUnclosedQuotes(text) ||
    hasUnclosedParens(text) ||
    CUT_OFF_CONJUNCTION_RE.test(text) ||
    /[,;:]\s*$/.test(text) ||
    /[—–-]\s*$/.test(text) ||
    /[«"„][^«"“»"]*$/.test(text) ||
    !/[.!?…]\s*$/.test(text)
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
    console.log("📋 Предложены варианты действий");
  }
}

export function mergeAssistantContinuation(original: string, continuation: string): string {
  const left = original.trimEnd();
  const right = continuation.trim();
  if (!right) return left;

  const needsSpace = !/\s$/.test(left) && !/^[.,!?;:—…)»"”']/.test(right);
  return needsSpace ? `${left} ${right}` : `${left}${right}`;
}

export async function prepareChatMessages({
  userId,
  characterId,
  character,
  user,
  apiKey,
  ragQueryText,
  excludeMessageId,
  continueMode = false,
  continueCutOff = false,
  continueSourceText,
  historyBeforeMessageId,
  intent = "general",
}: PrepareChatMessagesOptions) {
  const subscriptionActive = isSubscriptionActive(user);
  const maxContextTokens = getContextTokenLimit(user);
  const ragEligible = isRagEligible(user.subscriptionType, subscriptionActive);

  const [memorySummary, relevantMemories, selectedPersona] = await Promise.all([
    resolveChatMemorySummary(userId, characterId, apiKey, user),
    getRelevantMemories(userId, characterId, intent),
    getSelectedChatPersona(userId, characterId),
  ]);

  let systemPrompt = appendPersonaToSystemPrompt(
    buildChatSystemPrompt(character),
    selectedPersona
  );
  if (selectedPersona) {
    console.log(`[Persona] prompt user=${userId} character=${characterId} persona=${selectedPersona.id}`);
  }

  if (continueMode) {
    if (continueCutOff && continueSourceText?.trim()) {
      systemPrompt = `Внимание: ты должен продолжить предыдущее сообщение ассистента, которое было оборвано. Вот текст, который нужно продолжить:
«${continueSourceText.trim()}»
Продолжи ровно с того места, где остановился, не повторяй предыдущее, не начинай заново. Просто допиши недостающую часть.

${systemPrompt}`;
    } else {
      systemPrompt = `${systemPrompt}\n\nПродолжи ответ с того места, где остановился.`;
    }
  }

  if (!continueCutOff) {
    const randomEvent = pickRandomSceneEvent();
    if (randomEvent) {
      systemPrompt = appendRandomEventToPrompt(systemPrompt, randomEvent);
      console.log(`🎲 Случайное событие: ${randomEvent}`);
    }
  }

  const historyLimit = getHistoryMessageLimit(user.subscriptionType, subscriptionActive);
  const subscriptionLogType = subscriptionActive ? user.subscriptionType ?? "unknown" : "start";

  let historyRows;

  if (historyBeforeMessageId) {
    const cutoffMessage = await prisma.message.findUnique({
      where: { id: historyBeforeMessageId },
      select: { createdAt: true },
    });

    if (!cutoffMessage) {
      throw new Error("Сообщение для истории не найдено");
    }

    historyRows = await prisma.message.findMany({
      where: {
        characterId,
        userId,
        createdAt: { lt: cutoffMessage.createdAt },
      },
      orderBy: { createdAt: "desc" },
      take: historyLimit,
    });
    historyRows = historyRows.reverse();
  } else {
    historyRows = await prisma.message.findMany({
      where: { characterId, userId },
      orderBy: { createdAt: "desc" },
      take: historyLimit,
    });
    historyRows = historyRows.reverse();
  }

  const totalHistoryTokens = historyRows.reduce((sum, msg) => sum + countTokens(msg.content), 0);
  let ragContextText: string | null = null;
  let ragUsed = false;

  if (ragEligible && ragQueryText) {
    if (totalHistoryTokens > RAG_HISTORY_TOKEN_THRESHOLD) {
      try {
        const ragMessages = await searchRelevantMessages(
          userId,
          characterId,
          ragQueryText,
          apiKey,
          excludeMessageId
        );
        console.log(`🔍 RAG: найдено ${ragMessages.length} релевантных сообщений`);
        ragContextText = formatRagContext(ragMessages)?.text ?? null;
        ragUsed = Boolean(ragContextText);
      } catch (ragError) {
        console.error("🔍 RAG: ошибка поиска релевантных сообщений", ragError);
      }
    } else {
      console.log(
        `🔍 RAG: пропущен (история слишком короткая: ${totalHistoryTokens} токенов)`
      );
    }
  }

  const reservedTokens = countTokens(systemPrompt);
  const allocations = allocateTokens([], maxContextTokens, reservedTokens);
  const summaryText = memorySummary
    ? trimTextToTokenLimit(memorySummary, allocations.summary)
    : "";
  const ragText = ragContextText
    ? trimTextToTokenLimit(ragContextText, allocations.retrieved)
    : "";
  const coreEpisodicText = relevantMemories.text
    ? trimTextToTokenLimit(relevantMemories.text, allocations.coreEpisodic)
    : "";

  if (coreEpisodicText) {
    systemPrompt = `${systemPrompt}\n\n${coreEpisodicText}`;
  }
  if (summaryText) {
    systemPrompt = appendMemoryToSystemPrompt(systemPrompt, summaryText);
  }
  if (ragText) {
    systemPrompt = appendRagToSystemPrompt(systemPrompt, { text: ragText, count: 1 });
  }

  console.log(
    `📚 Загружено ${historyRows.length} сообщений для подписки ${subscriptionLogType} (лимит: ${historyLimit}, контекст: ${maxContextTokens})`
  );

  const messagesForAI: ChatCompletionMessage[] = [
    { role: "system", content: systemPrompt },
    ...historyRows.map((msg) => ({
      role: (msg.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: msg.content,
    })),
  ];

  const systemTokens = countTokens(systemPrompt);
  const recentBudget = Math.min(
    allocations.recentChat,
    Math.max(0, maxContextTokens - systemTokens)
  );

  const { messages: trimmedMessages, totalTokens } = trimMessagesToTokenLimit(
    messagesForAI,
    Math.min(maxContextTokens, systemTokens + recentBudget)
  );

  console.log(
    `📊 Отправлено ${trimmedMessages.length} сообщений (токенов: ${totalTokens}, лимит: ${maxContextTokens})${summaryText ? ", с предысторией" : ""}${coreEpisodicText ? ", core/episodic" : ""}${ragUsed ? ", RAG" : ""}${continueMode ? ", continue" : ""}`
  );

  return {
    messages: trimmedMessages,
    totalTokens,
    maxContextTokens,
    memorySummary,
  };
}

export async function callChatCompletion(
  modelName: string,
  messages: ChatCompletionMessage[],
  apiKey: string
): Promise<string> {
  const response = await axios.post(
    `${KODIKROUTER_URL}/chat/completions`,
    {
      model: modelName,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const reply = response.data.choices[0]?.message?.content?.trim() ?? "";
  if (!reply) {
    throw new Error("Пустой ответ от ИИ");
  }

  return reply;
}

export async function streamChatCompletion(
  modelName: string,
  messages: ChatCompletionMessage[],
  apiKey: string
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`${KODIKROUTER_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.7,
      stream: true,
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Ошибка стриминга ИИ: ${response.status}${details ? ` ${details.slice(0, 300)}` : ""}`
    );
  }

  if (!response.body) {
    throw new Error("Пустой поток ответа от ИИ");
  }

  return response.body;
}

export async function chargeForChatRequest({
  userId,
  costVC,
  counters,
  characterName,
  modelDisplayName,
}: {
  userId: string;
  costVC: number;
  counters: ReturnType<typeof normalizeUserCounters>;
  characterName: string;
  modelDisplayName: string;
}) {
  const nextDailyRequests = counters.dailyRequests + 1;

  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: {
      verseCoins: costVC > 0 ? { decrement: costVC } : undefined,
      dailyRequests: nextDailyRequests,
      dailyRequestsDate: counters.dailyRequestsDate,
    },
    select: { verseCoins: true },
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

  return {
    remainingVC: updatedUser.verseCoins,
    nextDailyRequests,
    limitWarning: getDailyLimitWarning(nextDailyRequests),
  };
}

export function buildChatResponsePayload({
  costVC,
  remainingVC,
  nextDailyRequests,
  limitWarning,
  model,
  greetingMessage,
  userMessage,
  assistantMessage,
}: {
  costVC: number;
  remainingVC: number;
  nextDailyRequests: number;
  limitWarning: string | null;
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
    dailyRequests: nextDailyRequests,
    dailyLimit: DAILY_REQUEST_LIMIT,
    limitWarning,
    chargedCoins: costVC,
    remainingCoins: remainingVC,
  };
}
