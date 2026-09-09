import axios from "axios";
import { encoding_for_model } from "tiktoken";
import { prisma } from "@/lib/prisma";
import { getRelevantMemories } from "@/lib/advancedMemory";
import { appendPersonaToSystemPrompt } from "@/lib/persona";
import { getSelectedChatPersona } from "@/lib/personaService";
import { buildChatSystemPrompt } from "@/lib/chatSystemPrompt";
import {
  appendMemoryToSystemPrompt,
  readChatMemorySummary,
  resolveChatMemorySummary,
} from "@/lib/chatMemory";
import type { UserIntent } from "@/lib/intentAnalyzer";
import {
  appendRagToSystemPrompt,
  formatRagContext,
  isRagEligible,
  shouldUseRag,
  searchRelevantMessages,
} from "@/lib/messageEmbeddings";
import {
  getContextTokenLimit,
  getHistoryMessageLimit,
  isSubscriptionActive,
  type EconomyModel,
} from "@/lib/verseChatEconomy";
import { applyPendingSubscriptionIfDue } from "@/lib/subscriptionState";
import { spendCoins } from "@/lib/verseCoins";

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
    console.log(`[Chat] Using stored systemPrompt character=${character.id}`);
    return stored;
  }
  console.log(`[Chat] Fallback buildChatSystemPrompt character=${character.id}`);
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

  console.log(
    `[ContextStrategy] intent=${intent} recent=${recentChat} summary=${summary} rag=${retrieved} episodic=${coreEpisodic} available=${available}`
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
  locale?: string;
  refreshSummary?: boolean;
};

export type PreparedChatMessages = {
  messages: ChatCompletionMessage[];
  totalTokens: number;
  maxContextTokens: number;
  memorySummary: string | null;
};

export type FastChatContext = {
  systemPromptBase: string;
  memorySummary: string | null;
  relevantMemoriesText: string;
  historyRows: Array<{ role: string; content: string }>;
  totalHistoryTokens: number;
  ragEligible: boolean;
  maxContextTokens: number;
  historyLimit: number;
  subscriptionLogType: string;
  locale: string;
};

export function shouldWaitForRag(intent: string): boolean {
  return intent === "fact" || intent === "question";
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
}) {
  if (historyBeforeMessageId) {
    const cutoffMessage = await prisma.message.findUnique({
      where: { id: historyBeforeMessageId },
      select: { createdAt: true },
    });

    if (!cutoffMessage) {
      throw new Error("Сообщение для истории не найдено");
    }

    const rows = await prisma.message.findMany({
      where: {
        characterId,
        userId,
        createdAt: { lt: cutoffMessage.createdAt },
      },
      orderBy: { createdAt: "desc" },
      take: historyLimit,
      select: { role: true, content: true },
    });
    return rows.reverse();
  }

  const rows = await prisma.message.findMany({
    where: { characterId, userId },
    orderBy: { createdAt: "desc" },
    take: historyLimit,
    select: { role: true, content: true },
  });
  return rows.reverse();
}

export function assemblePreparedChatMessages(
  context: FastChatContext,
  intent: UserIntent = "general",
  ragContextText: string | null = null
): PreparedChatMessages {
  let systemPrompt = context.systemPromptBase;
  const reservedTokens = countTokens(systemPrompt);
  const allocations = allocateTokens([], context.maxContextTokens, reservedTokens, intent);
  const summaryText = context.memorySummary
    ? trimTextToTokenLimit(context.memorySummary, allocations.summary)
    : "";
  const ragText = ragContextText ? trimTextToTokenLimit(ragContextText, allocations.retrieved) : "";
  const coreEpisodicText = context.relevantMemoriesText
    ? trimTextToTokenLimit(context.relevantMemoriesText, allocations.coreEpisodic)
    : "";

  if (coreEpisodicText) {
    systemPrompt = `${systemPrompt}\n\n${coreEpisodicText}`;
  }
  if (summaryText) {
    systemPrompt = appendMemoryToSystemPrompt(systemPrompt, summaryText, context.locale);
  }
  if (ragText) {
    systemPrompt = appendRagToSystemPrompt(systemPrompt, { text: ragText, count: 1 }, context.locale);
  }

  console.log(
    `📚 Загружено ${context.historyRows.length} сообщений для подписки ${context.subscriptionLogType} (лимит: ${context.historyLimit}, контекст: ${context.maxContextTokens})`
  );

  const messagesForAI: ChatCompletionMessage[] = [
    { role: "system", content: systemPrompt },
    ...context.historyRows.map((msg) => ({
      role: (msg.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: msg.content,
    })),
  ];

  const systemTokens = countTokens(systemPrompt);
  const recentBudget = Math.min(
    allocations.recentChat,
    Math.max(0, context.maxContextTokens - systemTokens)
  );

  const { messages, totalTokens } = trimMessagesToTokenLimit(
    messagesForAI,
    Math.min(context.maxContextTokens, systemTokens + recentBudget)
  );

  console.log(
    `📊 Отправлено ${messages.length} сообщений (токенов: ${totalTokens}, лимит: ${context.maxContextTokens})${summaryText ? ", с предысторией" : ""}${coreEpisodicText ? ", core/episodic" : ""}${ragText ? ", RAG" : ""}`
  );

  return {
    messages,
    totalTokens,
    maxContextTokens: context.maxContextTokens,
    memorySummary: context.memorySummary,
  };
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
  intent = "general",
  locale = "ru",
  refreshSummary = false,
}: PrepareChatMessagesOptions): Promise<FastChatContext> {
  const subscriptionActive = isSubscriptionActive(user);
  const maxContextTokens = getContextTokenLimit(user);
  const ragEligible = isRagEligible(user.subscriptionType, subscriptionActive);
  const historyLimit = getHistoryMessageLimit(user.subscriptionType, subscriptionActive);
  const subscriptionLogType = subscriptionActive ? user.subscriptionType ?? "unknown" : "start";

  const [memorySummary, relevantMemories, selectedPersona, historyRows] = await Promise.all([
    refreshSummary
      ? resolveChatMemorySummary(userId, characterId, apiKey, user)
      : readChatMemorySummary(userId, characterId),
    getRelevantMemories(userId, characterId, intent, maxContextTokens),
    getSelectedChatPersona(userId, characterId),
    loadChatHistoryRows({ userId, characterId, historyLimit, historyBeforeMessageId }),
  ]);

  let systemPromptBase = appendPersonaToSystemPrompt(
    resolveChatSystemPrompt(character, locale),
    selectedPersona,
    locale
  );
  if (selectedPersona) {
    console.log(`[Persona] prompt user=${userId} character=${characterId} persona=${selectedPersona.id}`);
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

  const totalHistoryTokens = historyRows.reduce((sum, msg) => sum + countTokens(msg.content), 0);

  return {
    systemPromptBase,
    memorySummary,
    relevantMemoriesText: relevantMemories.text ?? "",
    historyRows,
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
}: {
  userId: string;
  characterId: string;
  apiKey: string;
  ragQueryText?: string;
  excludeMessageId?: string;
  intent: UserIntent;
  ragEligible: boolean;
  totalHistoryTokens: number;
}): Promise<string | null> {
  const ragDecision = shouldUseRag({
    ragEligible,
    userQuery: ragQueryText,
    intent,
    historyTokens: totalHistoryTokens,
  });
  console.log(
    `[RAGDecision] use=${ragDecision.use ? "yes" : "no"} reason=${ragDecision.reason} tokens=${totalHistoryTokens} intent=${intent}`
  );

  if (!ragDecision.use || !ragQueryText) {
    return null;
  }

  try {
    const ragMessages = await searchRelevantMessages(
      userId,
      characterId,
      ragQueryText,
      apiKey,
      excludeMessageId
    );
    console.log(`🔍 RAG: найдено ${ragMessages.length} релевантных сообщений`);
    return formatRagContext(ragMessages)?.text ?? null;
  } catch (ragError) {
    console.error("🔍 RAG: ошибка поиска релевантных сообщений", ragError);
    return null;
  }
}

export async function prepareChatMessages(options: PrepareChatMessagesOptions): Promise<PreparedChatMessages> {
  const intent = options.intent ?? "general";
  const fastContext = await prepareFastContext({ ...options, refreshSummary: options.refreshSummary ?? true });
  const ragContextText = await searchRagContext({
    userId: options.userId,
    characterId: options.characterId,
    apiKey: options.apiKey,
    ragQueryText: options.ragQueryText,
    excludeMessageId: options.excludeMessageId,
    intent,
    ragEligible: fastContext.ragEligible,
    totalHistoryTokens: fastContext.totalHistoryTokens,
  });
  return assemblePreparedChatMessages(fastContext, intent, ragContextText);
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
