import axios from "axios";
import { prisma } from "@/lib/prisma";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const SUMMARY_MODEL = "openai/gpt-4o-mini";
const MEMORY_MESSAGE_THRESHOLD = 50;
const MESSAGES_TO_SUMMARIZE = 20;

const SUMMARY_PROMPT =
  "Сделай краткую выжимку этого диалога (5–7 предложений), сохранив ключевые детали: тему разговора, важные события, эмоциональный фон.";

type DialogMessage = {
  role: string;
  content: string;
};

function formatDialogForSummary(messages: DialogMessage[]): string {
  return messages
    .map((message) => {
      const speaker = message.role === "user" ? "Пользователь" : "Персонаж";
      return `${speaker}: ${message.content}`;
    })
    .join("\n\n");
}

async function requestSummary(apiKey: string, dialogText: string): Promise<string> {
  const response = await axios.post(
    `${KODIKROUTER_URL}/chat/completions`,
    {
      model: SUMMARY_MODEL,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: dialogText },
      ],
      max_tokens: 400,
      temperature: 0.4,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const summary = response.data.choices[0]?.message?.content?.trim();
  if (!summary) {
    throw new Error("Пустая суммаризация от ИИ");
  }

  return summary;
}

export async function resolveChatMemorySummary(
  userId: string,
  characterId: string,
  apiKey: string
): Promise<string | null> {
  const existingMemory = await prisma.memory.findUnique({
    where: {
      userId_characterId: {
        userId,
        characterId,
      },
    },
    select: { summary: true },
  });

  if (existingMemory) {
    console.log(`🧠 Используется сохранённая суммаризация для user=${userId}, character=${characterId}`);
    return existingMemory.summary;
  }

  const messageCount = await prisma.message.count({
    where: { userId, characterId },
  });

  if (messageCount <= MEMORY_MESSAGE_THRESHOLD) {
    console.log(`🧠 Суммаризация не нужна: ${messageCount} сообщений (лимит ${MEMORY_MESSAGE_THRESHOLD})`);
    return null;
  }

  const oldestMessages = await prisma.message.findMany({
    where: { userId, characterId },
    orderBy: { createdAt: "asc" },
    take: MESSAGES_TO_SUMMARIZE,
  });

  if (oldestMessages.length === 0) {
    return null;
  }

  console.log(
    `🧠 Создание суммаризации: ${oldestMessages.length} старых сообщений (всего ${messageCount})`
  );

  const dialogText = formatDialogForSummary(oldestMessages);
  const summary = await requestSummary(apiKey, dialogText);

  await prisma.$transaction([
    prisma.memory.create({
      data: {
        userId,
        characterId,
        summary,
      },
    }),
    prisma.message.deleteMany({
      where: {
        id: { in: oldestMessages.map((message) => message.id) },
      },
    }),
  ]);

  console.log(`🧠 Суммаризация сохранена, удалено ${oldestMessages.length} сообщений`);

  return summary;
}

export function appendMemoryToSystemPrompt(systemPrompt: string, summary: string | null): string {
  if (!summary?.trim()) {
    return systemPrompt;
  }

  return `Краткая предыстория: ${summary.trim()}\n\n${systemPrompt}`;
}
