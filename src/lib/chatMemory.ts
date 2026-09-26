import axios from "axios";
import { encoding_for_model } from "tiktoken";
import { prisma } from "@/lib/prisma";
import { getContextTokenLimit } from "@/lib/chatEconomy";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";
import { recordSummaryMemoryEntry } from "@/lib/advancedMemory";
import { ensureMemoryHierarchyColumns } from "@/lib/ensureMemoryHierarchyColumns";
import { infoLog } from "@/lib/logger";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const SUMMARY_MODEL = "openai/gpt-4o-mini";
const KEEP_RECENT_MESSAGES = 25;

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

const SUMMARY_PROMPT = `Ты — суммаризатор ролевых диалогов. Твоя задача — сделать структурированную выжимку пары пользователь+персонаж.

Формат ответа (строго соблюдай):

## Постоянное
2–4 факта, которые НЕ меняются: кто персонаж, кто пользователь, где происходит действие, ключевые отношения. Если факт неизвестен — не выводи.

## Активные линии
Список из 2–7 незакрытых сюжетных линий: обещания, тайны, проверки, конфликты, цели. Каждая — одно предложение в настоящем времени.
Включай ТОЛЬКО то, что ещё не разрешено.
Пример: «Рокс проверяет, есть ли в пользователе искра».

## Недавние события
Список из 3–8 событий СТРОГО В ХРОНОЛОГИЧЕСКОМ ПОРЯДКЕ (от раннего к позднему). Только те, что ИЗМЕНИЛИ состояние мира или отношения:
- узнал важное, дал обещание, заключил договор, нашёл/потерял предмет, совершил действие с последствиями.
НЕ включай: эмоциональные реакции («улыбнулась», «удивился»), описания, рутинные действия («подошёл», «спросил»).

## Эмоциональный фон
Одно предложение: тёплое / напряжённое / игривое / романтичное / тревожное.

Требования:
- Максимум {{maxTokens}} токенов.
- Имена использовать точно, как в диалоге.
- Пустые разделы НЕ выводить.
- Без «в данном диалоге», «итак», «стоит отметить».`;

const CHAPTER_PROMPT = `Ты — суммаризатор части ролевого диалога. Сделай краткую выжимку СТРОГО В ХРОНОЛОГИЧЕСКОМ ПОРЯДКЕ.

Формат:

## События
2–5 значимых событий (только с последствиями). Одно предложение каждое.

## Активные линии
Если появились новые обещания, тайны или цели — добавь 1–3 строки.

Максимум {{maxTokens}} токенов. Имена — точно как в диалоге.`;

const MERGE_PROMPT = `Ты — суммаризатор ролевых диалогов. Объедини старую выжимку и новую часть в одну структурированную выжимку.

Формат:

## Постоянное
Взять из старой выжимки, обновить, если что-то изменилось.

## Активные линии
Объединить старые и новые линии. Если линия ЗАКРЫТА (обещание выполнено, тайна раскрыта, проверка завершена) — УБРАТЬ её. Оставить только незакрытые.

## Недавние события
Взять последние {{eventsLimit}} значимых событий из старой выжимки + новые события. Старые события вытесняются новыми, если их больше {{eventsLimit}}. Хронология строго от раннего к позднему.

## Эмоциональный фон

Требования:
- Максимум {{maxTokens}} токенов.
- Активные линии — только незакрытые.
- Не дублируй факты.
- Без вступлений.`;

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

function countTokens(text: string): number {
  try {
    const enc = encoding_for_model("gpt-4");
    const tokens = enc.encode(text);
    enc.free();
    return tokens.length;
  } catch {
    return Math.ceil(text.length / 4);
  }
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

function getHistoryForSummary(messages: DialogMessage[]): DialogMessage[] {
  if (messages.length <= KEEP_RECENT_MESSAGES) {
    return [];
  }

  return messages.slice(0, messages.length - KEEP_RECENT_MESSAGES);
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
  const response = await axios.post(
    `${KODIKROUTER_URL}/chat/completions`,
    {
      model: SUMMARY_MODEL,
      messages: [
        {
          role: "system",
          content: applyPromptVars(systemPrompt, { maxTokens, ...extraVars }),
        },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
      temperature: 0.4,
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

async function requestSummary(apiKey: string, dialogText: string, maxTokens: number): Promise<string> {
  return requestKodikText(apiKey, SUMMARY_PROMPT, dialogText, maxTokens);
}

async function requestChapterSummary(
  apiKey: string,
  chapterText: string,
  maxTokens: number
): Promise<string> {
  return requestKodikText(apiKey, CHAPTER_PROMPT, chapterText, maxTokens);
}

async function mergeSummaries(
  apiKey: string,
  oldSummary: string,
  newChapter: string,
  maxTokens: number,
  eventsLimit: number
): Promise<string> {
  const userContent = `## Старая выжимка:\n${oldSummary}\n\n## Новая часть:\n${newChapter}`;
  return requestKodikText(apiKey, MERGE_PROMPT, userContent, maxTokens, { eventsLimit });
}

async function persistMemorySummary(
  userId: string,
  characterId: string,
  summary: string,
  lastSummarizedAt: Date,
  summarizedMessageCount: number
): Promise<string> {
  await prisma.memory.upsert({
    where: { userId_characterId: { userId, characterId } },
    create: {
      userId,
      characterId,
      summary,
      lastSummarizedAt,
      summarizedMessageCount,
    },
    update: {
      summary,
      lastSummarizedAt,
      summarizedMessageCount,
    },
  });
  await recordSummaryMemoryEntry(userId, characterId, summary);
  return summary;
}

async function createArcSummary(
  userId: string,
  characterId: string,
  apiKey: string,
  messagesToSummarize: DialogMessage[],
  config: SummaryConfig,
  plan: string
): Promise<string | null> {
  if (messagesToSummarize.length === 0) {
    return null;
  }

  const dialogText = formatDialogForSummary(messagesToSummarize);
  const tokens = countTokens(dialogText);
  const summary = await requestSummary(apiKey, dialogText, config.maxTokens);
  await persistMemorySummary(
    userId,
    characterId,
    summary,
    lastSummarizedTimestamp(messagesToSummarize),
    messagesToSummarize.length
  );
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
  chapterMessages: DialogMessage[],
  config: SummaryConfig,
  plan: string
): Promise<string> {
  const chapterText = formatDialogForSummary(chapterMessages);
  const chapterTokens = countTokens(chapterText);
  const arcTokens = countTokens(existingSummary);
  const arcRatio = config.maxTokens > 0 ? arcTokens / config.maxTokens : 0;
  const eventsLimit = getRecentEventsLimit(arcTokens, config.maxTokens);
  infoLog(
    "Memory",
    `Arc size: ${arcTokens} tokens (ratio: ${arcRatio.toFixed(2)}) → eventsLimit: ${eventsLimit}`
  );
  const chapterSummary = await requestChapterSummary(apiKey, chapterText, config.maxTokens);
  const mergedSummary = await mergeSummaries(
    apiKey,
    existingSummary,
    chapterSummary,
    config.maxTokens,
    eventsLimit
  );
  await persistMemorySummary(
    userId,
    characterId,
    mergedSummary,
    lastSummarizedTimestamp(chapterMessages),
    existingCount + chapterMessages.length
  );
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

  const allMessages = await prisma.message.findMany({
    where: { userId, characterId },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true, createdAt: true },
  });

  if (existingMemory) {
    const since = existingMemory.lastSummarizedAt ?? existingMemory.createdAt;
    const newMessages = allMessages.filter((message) => message.createdAt > since);
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
  const existingMemory = await prisma.memory.findUnique({
    where: { userId_characterId: { userId, characterId } },
    select: { summary: true },
  });
  return existingMemory?.summary?.trim() || null;
}

export function appendMemoryToSystemPrompt(
  systemPrompt: string,
  summary: string | null,
  locale?: string
): string {
  if (!summary?.trim()) {
    return systemPrompt;
  }

  const heading = locale === "en" ? "Brief backstory" : "Краткая предыстория";
  return `${systemPrompt}\n\n${heading}: ${summary.trim()}`;
}

export async function forceRefreshMemorySummary(
  userId: string,
  characterId: string,
  apiKey: string,
  user?: {
    subscriptionType?: string | null;
    subscriptionEnd?: Date | string | null;
  }
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
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true, createdAt: true },
  });

  if (allMessages.length === 0) {
    return null;
  }

  if (!existingMemory) {
    const historyToSummarize =
      allMessages.length > KEEP_RECENT_MESSAGES
        ? getHistoryForSummary(allMessages)
        : allMessages;
    return createArcSummary(userId, characterId, apiKey, historyToSummarize, config, plan);
  }

  const since = existingMemory.lastSummarizedAt ?? existingMemory.createdAt;
  const newMessages = allMessages.filter((message) => message.createdAt > since);
  const chapterMessages =
    allMessages.length <= KEEP_RECENT_MESSAGES
      ? allMessages
      : getHistoryForSummary(newMessages.length > 0 ? newMessages : allMessages);

  if (chapterMessages.length === 0) {
    return existingMemory.summary;
  }

  return updateArcWithChapter(
    userId,
    characterId,
    apiKey,
    existingMemory.summary,
    existingMemory.summarizedMessageCount ?? 0,
    chapterMessages,
    config,
    plan
  );
}
