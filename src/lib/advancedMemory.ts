import axios from "axios";
import { prisma } from "@/lib/prisma";
import type { UserIntent } from "@/lib/intentAnalyzer";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const CORE_MEMORY_MODEL = "openai/gpt-4o-mini";
const EPISODIC_CAP = 100;

const CORE_DELTA_PROMPT =
  "Сравни ключевую память диалога с новым сообщением пользователя. Если в сообщении нет устойчивых новых фактов (имена, отношения, договорённости, характер, предпочтения, сюжетные решения), ответь строго одним словом: UNCHANGED. Иначе верни только обновлённую ключевую память целиком: краткий связный текст без воды, объединяющий старую память и новую информацию.";

const SHORT_CONTEXT_IMPORTANCE_THRESHOLD = 2;
const LONG_CONTEXT_IMPORTANCE_THRESHOLD = 1;
const SHORT_CONTEXT_TOKEN_LIMIT = 8000;

export function importanceScoreForIntent(intent: UserIntent): number {
  if (intent === "story" || intent === "action") return 3;
  if (intent === "fact") return 2;
  return 1;
}

export function episodicImportanceThreshold(maxContextTokens: number): number {
  return maxContextTokens < SHORT_CONTEXT_TOKEN_LIMIT
    ? SHORT_CONTEXT_IMPORTANCE_THRESHOLD
    : LONG_CONTEXT_IMPORTANCE_THRESHOLD;
}

function extractContentTokens(text: string): string[] {
  return text.toLowerCase().replace(/ё/g, "е").match(/[a-zа-я]{4,}/g) ?? [];
}

export function hasSubstantialNewCoreInfo(existingCore: string, userMessage: string): boolean {
  const message = userMessage.trim();
  if (message.length < 16) return false;

  const core = existingCore.trim().toLowerCase().replace(/ё/g, "е");
  if (!core) return true;

  const messageNorm = message.toLowerCase().replace(/ё/g, "е");
  if (core.includes(messageNorm)) return false;

  const tokens = extractContentTokens(message);
  if (tokens.length === 0) return false;

  const novel = tokens.filter((token) => !core.includes(token));
  return novel.length / tokens.length >= 0.3;
}

function isUnchangedDelta(text: string): boolean {
  return /^\s*unchanged\b/i.test(text.trim());
}

export type EpisodicMemoryItem = {
  id: string;
  event: string;
  timestamp: Date;
  importance: number;
};

export type RelevantMemories = {
  core: string | null;
  episodic: EpisodicMemoryItem[];
  text: string | null;
};

async function upsertMemoryEntry(
  userId: string,
  characterId: string,
  type: "summary" | "core" | "episodic",
  content: string,
  replaceExisting = false
) {
  const trimmed = content.trim();
  if (!trimmed) return;

  if (replaceExisting) {
    await prisma.memoryEntry.deleteMany({
      where: { userId, characterId, type },
    });
  }

  await prisma.memoryEntry.create({
    data: { userId, characterId, type, content: trimmed },
  });
}

async function summarizeCoreMemory(apiKey: string, previous: string, newInfo: string): Promise<string> {
  const response = await axios.post(
    `${KODIKROUTER_URL}/chat/completions`,
    {
      model: CORE_MEMORY_MODEL,
      messages: [
        { role: "system", content: CORE_DELTA_PROMPT },
        {
          role: "user",
          content: `Старая память:\n${previous.trim() || "(пусто)"}\n\nНовое сообщение пользователя:\n${newInfo.trim()}`,
        },
      ],
      max_tokens: 500,
      temperature: 0.3,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const content = response.data?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Пустое обновление Core Memory");
  }

  return content;
}

export async function ensureCoreMemory(userId: string, characterId: string, seed = "") {
  const existing = await prisma.coreMemory.findUnique({
    where: { userId_characterId: { userId, characterId } },
  });

  if (existing) return existing;

  const created = await prisma.coreMemory.create({
    data: {
      userId,
      characterId,
      content: seed.trim(),
    },
  });

  if (created.content) {
    await upsertMemoryEntry(userId, characterId, "core", created.content, true);
  }

  console.log(`[CoreMemory] created user=${userId} character=${characterId}`);
  return created;
}

export async function updateCoreMemory(
  userId: string,
  characterId: string,
  newInfo: string,
  apiKey: string
) {
  const info = newInfo.trim();
  if (!info) return null;

  try {
    const existing = await ensureCoreMemory(userId, characterId);

    if (!hasSubstantialNewCoreInfo(existing.content, info)) {
      console.log(
        `[CoreUpdate] skipped no-new-info user=${userId} character=${characterId}`
      );
      return existing;
    }

    const content = await summarizeCoreMemory(apiKey, existing.content, info);

    if (isUnchangedDelta(content) || content.trim() === existing.content.trim()) {
      console.log(
        `[CoreUpdate] skipped unchanged user=${userId} character=${characterId}`
      );
      return existing;
    }

    const saved = await prisma.coreMemory.upsert({
      where: { userId_characterId: { userId, characterId } },
      create: { userId, characterId, content },
      update: { content },
    });

    await upsertMemoryEntry(userId, characterId, "core", content, true);
    console.log(
      `[CoreUpdate] updated user=${userId} character=${characterId} chars=${content.length}`
    );
    console.log(
      `[CoreMemory] updated user=${userId} character=${characterId} chars=${content.length}`
    );
    return saved;
  } catch (error) {
    console.error("[CoreUpdate] update failed", error);
    console.error("[CoreMemory] update failed", error);
    return null;
  }
}

export async function addEpisodicMemory(
  userId: string,
  characterId: string,
  event: string,
  importance = 1
) {
  const trimmed = event.trim();
  if (!trimmed) return null;

  const clampedImportance = Math.min(5, Math.max(1, Math.round(importance)));

  const created = await prisma.episodicMemory.create({
    data: {
      userId,
      characterId,
      event: trimmed.slice(0, 2000),
      importance: clampedImportance,
    },
  });

  await upsertMemoryEntry(userId, characterId, "episodic", created.event);

  const total = await prisma.episodicMemory.count({ where: { userId, characterId } });
  const overflow = total - EPISODIC_CAP;
  if (overflow > 0) {
    const extra = await prisma.episodicMemory.findMany({
      where: { userId, characterId },
      orderBy: [{ importance: "asc" }, { timestamp: "asc" }],
      take: overflow,
      select: { id: true },
    });
    const extraIds = extra.map((item) => item.id);
    if (extraIds.length > 0) {
      await prisma.episodicMemory.deleteMany({
        where: { id: { in: extraIds } },
      });
    }
  }

  console.log(
    `[Episodic] added user=${userId} character=${characterId} importance=${clampedImportance}`
  );
  return created;
}

export async function deleteEpisodicMemory(
  userId: string,
  characterId: string,
  episodicId: string
) {
  const existing = await prisma.episodicMemory.findFirst({
    where: { id: episodicId, userId, characterId },
  });

  if (!existing) return false;

  await prisma.episodicMemory.delete({ where: { id: existing.id } });
  await prisma.memoryEntry.deleteMany({
    where: {
      userId,
      characterId,
      type: "episodic",
      content: existing.event,
    },
  });

  console.log(`[Episodic] deleted id=${episodicId} user=${userId} character=${characterId}`);
  return true;
}

function episodicLimitForIntent(intent: UserIntent): number {
  switch (intent) {
    case "story":
    case "action":
      return 10;
    case "fact":
    case "question":
      return 2;
    default:
      return 3;
  }
}

export function formatRelevantMemories(memories: RelevantMemories): string | null {
  const sections: string[] = [];

  if (memories.core?.trim()) {
    sections.push(`Ключевая память:\n${memories.core.trim()}`);
  }

  if (memories.episodic.length > 0) {
    const lines = memories.episodic.map((item) => {
      const date = item.timestamp.toISOString().slice(0, 10);
      return `- [${date}] ${item.event}`;
    });
    sections.push(`Важные события:\n${lines.join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

export async function getRelevantMemories(
  userId: string,
  characterId: string,
  intent: UserIntent,
  maxContextTokens = 6000
): Promise<RelevantMemories> {
  const episodicTake = episodicLimitForIntent(intent);
  const minImportance = episodicImportanceThreshold(maxContextTokens);

  const [core, episodic] = await Promise.all([
    prisma.coreMemory.findUnique({
      where: { userId_characterId: { userId, characterId } },
      select: { content: true },
    }),
    prisma.episodicMemory.findMany({
      where: { userId, characterId, importance: { gte: minImportance } },
      orderBy: [{ importance: "desc" }, { timestamp: "desc" }],
      take: episodicTake,
      select: { id: true, event: true, timestamp: true, importance: true },
    }),
  ]);

  const memories: RelevantMemories = {
    core: core?.content?.trim() || null,
    episodic,
    text: null,
  };
  memories.text = formatRelevantMemories(memories);

  console.log(`[CoreMemory] retrieved user=${userId} character=${characterId} present=${memories.core ? "yes" : "no"}`);
  console.log(
    `[Episodic] retrieved intent=${intent} minImportance=${minImportance} events=${episodic.length}`
  );

  return memories;
}

export async function recordSummaryMemoryEntry(
  userId: string,
  characterId: string,
  summary: string
) {
  await upsertMemoryEntry(userId, characterId, "summary", summary, true);
}

export async function getChatMemoryPayload(userId: string, characterId: string) {
  const [coreMemory, episodicMemories, summary] = await Promise.all([
    prisma.coreMemory.findUnique({
      where: { userId_characterId: { userId, characterId } },
      select: { id: true, content: true, updatedAt: true },
    }),
    prisma.episodicMemory.findMany({
      where: { userId, characterId },
      orderBy: { timestamp: "desc" },
      select: { id: true, event: true, timestamp: true, importance: true },
    }),
    prisma.memory.findUnique({
      where: { userId_characterId: { userId, characterId } },
      select: { summary: true, createdAt: true },
    }),
  ]);

  return { coreMemory, episodicMemories, summary };
}

export async function setCoreMemoryContent(userId: string, characterId: string, content: string) {
  const trimmed = content.trim();
  const saved = await prisma.coreMemory.upsert({
    where: { userId_characterId: { userId, characterId } },
    create: { userId, characterId, content: trimmed },
    update: { content: trimmed },
  });

  if (trimmed) {
    await upsertMemoryEntry(userId, characterId, "core", trimmed, true);
  } else {
    await prisma.memoryEntry.deleteMany({
      where: { userId, characterId, type: "core" },
    });
  }

  console.log(`[CoreMemory] saved manually user=${userId} character=${characterId}`);
  return saved;
}

export async function clearChatMemories(userId: string, characterId: string) {
  await Promise.all([
    prisma.memory.deleteMany({ where: { userId, characterId } }),
    prisma.coreMemory.deleteMany({ where: { userId, characterId } }),
    prisma.episodicMemory.deleteMany({ where: { userId, characterId } }),
    prisma.memoryEntry.deleteMany({ where: { userId, characterId } }),
  ]);
}

export async function ingestUserMessageMemory({
  userId,
  characterId,
  userMessage,
  intent,
  apiKey,
}: {
  userId: string;
  characterId: string;
  userMessage: string;
  intent: UserIntent;
  apiKey: string;
}) {
  await ensureCoreMemory(userId, characterId);

  const importance = importanceScoreForIntent(intent);
  console.log(`[Importance] intent=${intent} score=${importance}`);
  await addEpisodicMemory(userId, characterId, userMessage, importance);

  await updateCoreMemory(userId, characterId, userMessage, apiKey);
}
