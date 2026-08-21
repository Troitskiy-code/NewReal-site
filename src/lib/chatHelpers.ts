import axios from "axios";
import { encoding_for_model } from "tiktoken";
import { prisma } from "@/lib/prisma";
import { buildChatSystemPrompt } from "@/lib/chatSystemPrompt";
import { appendMemoryToSystemPrompt, resolveChatMemorySummary } from "@/lib/chatMemory";
import {
  appendRagToSystemPrompt,
  formatRagContext,
  isUniverseRagEligible,
  searchRelevantMessages,
} from "@/lib/messageEmbeddings";
import {
  DAILY_REQUEST_LIMIT,
  getContextTokenLimit,
  getDailyLimitWarning,
  getHistoryMessageLimit,
  isSubscriptionActive,
  normalizeUserCounters,
  type EconomyModel,
} from "@/lib/verseChatEconomy";

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

export async function getOrCreateBaseModel(): Promise<EconomyModel> {
  let baseModel = await prisma.model.findFirst({
    where: { isActive: true },
    orderBy: { priceVC: "asc" },
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

  let model = user.selectedModel;
  if (!model || !model.isActive) {
    model = baseModel;
  }

  return {
    user,
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
  historyBeforeMessageId?: string;
};

export async function prepareChatMessages({
  userId,
  characterId,
  character,
  user,
  model,
  apiKey,
  ragQueryText,
  excludeMessageId,
  continueMode = false,
  historyBeforeMessageId,
}: PrepareChatMessagesOptions) {
  const subscriptionActive = isSubscriptionActive(user);
  const maxContextTokens = getContextTokenLimit(user, model);
  const universeRag = isUniverseRagEligible(user.subscriptionType, subscriptionActive);

  const memorySummary = await resolveChatMemorySummary(
    userId,
    characterId,
    apiKey,
    maxContextTokens
  );

  let systemPrompt = appendMemoryToSystemPrompt(buildChatSystemPrompt(character), memorySummary);

  if (continueMode) {
    systemPrompt = `${systemPrompt}\n\nПродолжи ответ с того места, где остановился.`;
  }

  if (universeRag && ragQueryText) {
    try {
      const ragMessages = await searchRelevantMessages(
        userId,
        characterId,
        ragQueryText,
        apiKey,
        excludeMessageId
      );
      console.log(`🔍 RAG: найдено ${ragMessages.length} релевантных сообщений`);
      systemPrompt = appendRagToSystemPrompt(systemPrompt, formatRagContext(ragMessages));
    } catch (ragError) {
      console.error("🔍 RAG: ошибка поиска релевантных сообщений", ragError);
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

  const { messages: trimmedMessages, totalTokens } = trimMessagesToTokenLimit(
    messagesForAI,
    maxContextTokens
  );

  console.log(
    `📊 Отправлено ${trimmedMessages.length} сообщений (токенов: ${totalTokens}, лимит: ${maxContextTokens})${memorySummary ? ", с предысторией" : ""}${universeRag ? ", RAG" : ""}${continueMode ? ", continue" : ""}`
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
  userMessage,
  assistantMessage,
}: {
  costVC: number;
  remainingVC: number;
  nextDailyRequests: number;
  limitWarning: string | null;
  model: EconomyModel;
  userMessage?: { id: string; role: string; content: string; createdAt: Date };
  assistantMessage: { id: string; role: string; content: string; createdAt: Date };
}) {
  return {
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
