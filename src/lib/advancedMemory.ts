import axios from "axios";
import { prisma } from "@/lib/prisma";
import type { UserIntent } from "@/lib/intentAnalyzer";
import { debugLog, errorLog, infoLog } from "@/lib/logger";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const CORE_MEMORY_MODEL = "google/gemma-4-31b-it";
const EVENT_CLASSIFIER_MODEL = "openai/gpt-4o-mini";
const EPISODIC_CAP = 300;
export const EDITOR_EPISODIC_MIN_IMPORTANCE = 2;
export const MANUAL_EPISODIC_IMPORTANCE = 3;

const CORE_PROMPT = `Ты — анализатор устойчивых фактов о персонаже и пользователе в ролевой игре.

Извлеки ТОЛЬКО стабильные факты, которые не меняются от события к событию:
- Характер и привычки персонажа.
- Характер и привычки пользователя.
- Устойчивые отношения между ними (не события, а общее состояние).
- Долгосрочные цели и мотивы.

НЕ включай:
- События и действия («персонаж пошёл в бар», «пользователь спросил о парне»).
- Эмоциональные реакции.
- Разовые фразы и реплики.

Формат ответа:
## Персонаж
## Пользователь
## Отношения (общее состояние)

Если новых устойчивых фактов нет — ответь ровно словом: UNCHANGED`;

const EVENT_CLASSIFIER_PROMPT = `Определи, содержит ли следующее сообщение пользователя событие с последствиями в ролевой игре.

Событие с последствиями — это:
- Узнал важную информацию.
- Дал обещание или заключил договор.
- Совершил действие, меняющее состояние (купил, нашёл, потерял, помог, предал).
- Раскрыл тайну или задал сюжетно важный вопрос.

НЕ является событием:
- Приветствия, болтовня, эмоции.
- Рутинные действия без последствий («подошёл», «посмотрел»).
- Вопросы общего характера («как дела?»).

Ответь СТРОГО в формате JSON:
{ "isEvent": true/false, "importance": 1-3, "text": "краткая формулировка события (макс 15 слов) или пусто" }

importance:
- 3: сюжетно важное (предательство, признание, находка артефакта).
- 2: значимое (договорённость, раскрытие детали).
- 1: не событие.

Сообщение пользователя: {{message}}`;

const TRIVIAL_MESSAGE_RE =
  /^(привет|здравствуй(?:те)?|хай|hello|hi|ok|ок|спасибо|thanks|thank you|лол|ха-?ха|ахах+|ммм+|ага|угу|да|нет|хорошо|ладно)[\s!.?]*$/iu;
const SMALLTALK_QUESTION_RE =
  /^(как дела|что делаешь|чем занимаешься|как ты|что нового)[\s!?.,]*$/iu;

const SHORT_CONTEXT_IMPORTANCE_THRESHOLD = 2;
const FILLER_TOKEN_RE =
  /^(привет|здравствуйте|здравствуй|хай|hello|hi|ok|ок|спасибо|thanks|thank|you|лол|хаха|ахах+|ммм+|ага|угу|да|нет|хорошо|ладно|как|дела|что|делаешь|чем|занимаешься|ты|нового)$/iu;

export type EventClassification = {
  isEvent: boolean;
  importance: number;
  text: string;
};

export type EpisodicCounts = {
  1: number;
  2: number;
  3: number;
};

export function importanceScoreForIntent(intent: UserIntent): number {
  if (intent === "story" || intent === "action") return 3;
  if (intent === "fact") return 2;
  return 1;
}

export function isTrivialMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 15) return true;

  const normalized = trimmed
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return true;
  if (TRIVIAL_MESSAGE_RE.test(normalized)) return true;
  if (SMALLTALK_QUESTION_RE.test(normalized)) return true;

  const tokens = normalized.split(" ").filter(Boolean);
  const meaningful = tokens.filter((token) => !FILLER_TOKEN_RE.test(token) && token.length > 2);
  return meaningful.length === 0;
}

function parseClassifierJson(raw: string): EventClassification | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      isEvent?: unknown;
      importance?: unknown;
      text?: unknown;
    };
    const importance = Math.min(3, Math.max(1, Math.round(Number(parsed.importance) || 1)));
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    const isEvent = parsed.isEvent === true || parsed.isEvent === "true";
    return { isEvent, importance, text };
  } catch {
    return null;
  }
}

export async function classifyEvent(message: string, apiKey: string): Promise<EventClassification> {
  const fallback: EventClassification = { isEvent: false, importance: 1, text: "" };

  try {
    const response = await axios.post(
      `${KODIKROUTER_URL}/chat/completions`,
      {
        model: EVENT_CLASSIFIER_MODEL,
        messages: [
          {
            role: "user",
            content: EVENT_CLASSIFIER_PROMPT.replace("{{message}}", message.trim()),
          },
        ],
        max_tokens: 150,
        temperature: 0,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const raw = response.data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return fallback;

    const parsed = parseClassifierJson(raw);
    if (!parsed) return fallback;

    const text =
      parsed.text ||
      message
        .trim()
        .split(/\s+/)
        .slice(0, 15)
        .join(" ");

    return {
      isEvent: parsed.isEvent && parsed.importance >= 2 && text.length > 0,
      importance: parsed.importance,
      text,
    };
  } catch (error) {
    errorLog("Memory", "event classifier failed", error);
    return fallback;
  }
}

export async function isEventAlreadyInSummary(
  userId: string,
  characterId: string,
  eventText: string
): Promise<boolean> {
  const memory = await prisma.memory.findUnique({
    where: { userId_characterId: { userId, characterId } },
    select: { summary: true },
  });
  if (!memory?.summary) return false;

  const eventWords = eventText
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 4);
  const summaryLower = memory.summary.toLowerCase();
  const matches = eventWords.filter((word) => summaryLower.includes(word)).length;

  return eventWords.length > 0 && matches / eventWords.length > 0.5;
}

function emptyEpisodicCounts(): EpisodicCounts {
  return { 1: 0, 2: 0, 3: 0 };
}

function tallyEpisodicCounts(rows: Array<{ importance: number }>): EpisodicCounts {
  const counts = emptyEpisodicCounts();
  for (const row of rows) {
    if (row.importance >= 3) counts[3] += 1;
    else if (row.importance === 2) counts[2] += 1;
    else counts[1] += 1;
  }
  return counts;
}

export function episodicImportanceThreshold(_maxContextTokens: number): number {
  return SHORT_CONTEXT_IMPORTANCE_THRESHOLD;
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
        { role: "system", content: CORE_PROMPT },
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

  debugLog("CoreMemory", `created user=${userId} character=${characterId}`);
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
      infoLog("Memory", "Core updated: 0 new facts, 1 unchanged");
      debugLog(
        "CoreUpdate",
        `skipped no-new-info user=${userId} character=${characterId}`
      );
      return existing;
    }

    const content = await summarizeCoreMemory(apiKey, existing.content, info);

    if (isUnchangedDelta(content) || content.trim() === existing.content.trim()) {
      infoLog("Memory", "Core updated: 0 new facts, 1 unchanged");
      debugLog(
        "CoreUpdate",
        `skipped unchanged user=${userId} character=${characterId}`
      );
      return existing;
    }

    const saved = await prisma.coreMemory.upsert({
      where: { userId_characterId: { userId, characterId } },
      create: { userId, characterId, content },
      update: { content },
    });

    await upsertMemoryEntry(userId, characterId, "core", content, true);
    infoLog("Memory", "Core updated: 1 new facts, 0 unchanged");
    debugLog(
      "CoreUpdate",
      `updated user=${userId} character=${characterId} chars=${content.length}`
    );
    debugLog(
      "CoreMemory",
      `updated user=${userId} character=${characterId} chars=${content.length}`
    );
    return saved;
  } catch (error) {
    errorLog("CoreUpdate", "update failed", error);
    errorLog("CoreMemory", "update failed", error);
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

  debugLog(
    "Episodic",
    `added user=${userId} character=${characterId} importance=${clampedImportance}`
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

  debugLog("MemoryEditor", `episodic deleted id=${episodicId} user=${userId} character=${characterId}`);
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

  debugLog("CoreMemory", `retrieved user=${userId} character=${characterId} present=${memories.core ? "yes" : "no"}`);
  debugLog(
    "Episodic",
    `retrieved intent=${intent} minImportance=${minImportance} events=${episodic.length}`
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

export async function getChatMemoryPayload(
  userId: string,
  characterId: string,
  options: { includeLowImportance?: boolean } = {}
) {
  const includeLowImportance = Boolean(options.includeLowImportance);

  const [coreMemory, episodicMemories, summary, importanceRows] = await Promise.all([
    prisma.coreMemory.findUnique({
      where: { userId_characterId: { userId, characterId } },
      select: { id: true, content: true, updatedAt: true },
    }),
    prisma.episodicMemory.findMany({
      where: {
        userId,
        characterId,
        ...(includeLowImportance ? {} : { importance: { gte: EDITOR_EPISODIC_MIN_IMPORTANCE } }),
      },
      orderBy: { timestamp: "desc" },
      select: { id: true, event: true, timestamp: true, importance: true },
    }),
    prisma.memory.findUnique({
      where: { userId_characterId: { userId, characterId } },
      select: { summary: true, createdAt: true },
    }),
    prisma.episodicMemory.findMany({
      where: { userId, characterId },
      select: { importance: true },
    }),
  ]);

  const episodicCounts = tallyEpisodicCounts(importanceRows);

  return {
    summary,
    core: coreMemory,
    coreMemory,
    episodic: episodicMemories,
    episodicMemories,
    episodicCounts,
    includeLowImportance,
  };
}

export async function setSummaryContent(userId: string, characterId: string, summary: string) {
  const trimmed = summary.trim();

  if (!trimmed) {
    await prisma.memory.deleteMany({ where: { userId, characterId } });
    await prisma.memoryEntry.deleteMany({
      where: { userId, characterId, type: "summary" },
    });
    debugLog("MemoryEditor", `summary cleared user=${userId} character=${characterId}`);
    return null;
  }

  const saved = await prisma.memory.upsert({
    where: { userId_characterId: { userId, characterId } },
    create: { userId, characterId, summary: trimmed },
    update: { summary: trimmed },
  });

  await recordSummaryMemoryEntry(userId, characterId, trimmed);
  debugLog("MemoryEditor", `summary saved user=${userId} character=${characterId} chars=${trimmed.length}`);
  return saved;
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

  debugLog("MemoryEditor", `core saved user=${userId} character=${characterId}`);
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

  if (isTrivialMessage(userMessage)) {
    infoLog("Memory", "Episodic skipped: trivial message");
  } else {
    const classification = await classifyEvent(userMessage, apiKey);
    if (!classification.isEvent || classification.importance < 2) {
      infoLog(
        "Memory",
        `Episodic skipped: non-event (importance: ${classification.importance})`
      );
    } else if (await isEventAlreadyInSummary(userId, characterId, classification.text)) {
      infoLog("Memory", "Episodic skipped: already in summary");
    } else {
      await addEpisodicMemory(userId, characterId, classification.text, classification.importance);
      infoLog("Memory", `Episodic saved: importance ${classification.importance}`);
    }
  }

  debugLog("Importance", `intent=${intent} classifier-driven episodic ingest`);
  await updateCoreMemory(userId, characterId, userMessage, apiKey);
}
