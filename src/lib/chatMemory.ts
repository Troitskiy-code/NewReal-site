import axios from "axios";
import { encoding_for_model } from "tiktoken";
import { prisma } from "@/lib/prisma";
import { getContextTokenLimit } from "@/lib/chatEconomy";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const SUMMARY_MODEL = "openai/gpt-4o-mini";
const MEMORY_TOKEN_THRESHOLD_RATIO = 0.5;
const MESSAGES_TO_SUMMARIZE = 20;

const SUMMARY_PROMPT =
  "Сделай краткую выжимку этого диалога (5–7 предложений), сохранив ключевые детали: тему разговора, важные события, эмоциональный фон.";

type DialogMessage = {
  role: string;
  content: string;
};

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
  apiKey: string,
  user: {
    subscriptionType?: string | null;
    subscriptionEnd?: Date | string | null;
  }
): Promise<string | null> {
  const maxContextTokens = getContextTokenLimit(user);

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

  const threshold = Math.floor(maxContextTokens * MEMORY_TOKEN_THRESHOLD_RATIO);

  const allMessages = await prisma.message.findMany({
    where: { userId, characterId },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true },
  });

  const totalTokens = allMessages.reduce((sum, message) => sum + countTokens(message.content), 0);

  if (totalTokens <= threshold) {
    console.log(`🧠 Суммаризация не нужна: ${totalTokens} токенов (порог ${threshold}, 50% от ${maxContextTokens})`);
    return null;
  }

  const oldestMessages = allMessages.slice(0, MESSAGES_TO_SUMMARIZE);

  if (oldestMessages.length === 0) {
    return null;
  }

  console.log(
    `🧠 Создание суммаризации: ${oldestMessages.length} старых сообщений (${totalTokens} токенов, порог ${threshold})`
  );

  const dialogText = formatDialogForSummary(oldestMessages);
  const summary = await requestSummary(apiKey, dialogText);

  await prisma.memory.create({
    data: {
      userId,
      characterId,
      summary,
    },
  });

  console.log(`🧠 Суммаризация сохранена (${oldestMessages.length} сообщений в выжимке, сообщения в БД сохранены)`);

  return summary;
}

export function appendMemoryToSystemPrompt(systemPrompt: string, summary: string | null): string {
  if (!summary?.trim()) {
    return systemPrompt;
  }

  return `Краткая предыстория: ${summary.trim()}\n\n${systemPrompt}`;
}
