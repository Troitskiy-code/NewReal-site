import axios from "axios";
import type { WorldEvent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { memoryToText } from "@/lib/persistentMemory";
import { extractLocation, formatCharacterStatus } from "@/lib/characterActivity";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const LIFECYCLE_MODEL = "openai/gpt-4o-mini";
const INITIATE_CHANCE = 0.1;
const MAX_EVENTS_IN_PROMPT = 8;
const MAX_ACTION_LENGTH = 280;
const UNSAFE_ACTION_PATTERN =
  /уби(ть|й)|напаст|избить|насили|suicide|rape|kill|attack|murder|bomb|terror/i;

export const LIFECYCLE_CONCURRENCY = 5;
export const LIFECYCLE_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LIFECYCLE_BATCH_LIMIT = 50;

export type LifecycleTickSummary = {
  checked: number;
  updated: number;
  errors: number;
  initiated: number;
};

function getKodikApiKey(): string {
  const apiKey = process.env.KODIKROUTER_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("KODIKROUTER_API_KEY не настроен");
  }
  return apiKey;
}

function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  const match = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = (match?.[1] ?? trimmed).slice(0, MAX_ACTION_LENGTH).trim();
  return sentence;
}

function isSafeAction(text: string): boolean {
  return Boolean(text) && !UNSAFE_ACTION_PATTERN.test(text);
}

function formatWorldEvents(worldEvents: WorldEvent[]): string {
  if (worldEvents.length === 0) return "нет недавних событий";

  return worldEvents
    .slice(0, MAX_EVENTS_IN_PROMPT)
    .map((event) => {
      const when = event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp);
      const place = event.location ? ` @ ${event.location}` : "";
      return `${when} [${event.type}]${place} ${event.description}`;
    })
    .join("\n");
}

async function completeLifecyclePrompt(prompt: string, maxTokens: number): Promise<string> {
  const response = await axios.post(
    `${KODIKROUTER_URL}/chat/completions`,
    {
      model: LIFECYCLE_MODEL,
      messages: [
        {
          role: "system",
          content:
            "Ты автономный персонаж в безопасном ролевом мире. Отвечай кратко, одним предложением. Никакой агрессии, насилия и принуждения.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.8,
    },
    {
      headers: {
        Authorization: `Bearer ${getKodikApiKey()}`,
        "Content-Type": "application/json",
      },
    }
  );

  const raw = response.data?.choices?.[0]?.message?.content;
  return firstSentence(typeof raw === "string" ? raw : "");
}

async function runPool(
  items: string[],
  concurrency: number,
  worker: (item: string) => Promise<{ initiated: boolean }>
): Promise<PromiseSettledResult<{ initiated: boolean }>[]> {
  const results: PromiseSettledResult<{ initiated: boolean }>[] = [];
  let index = 0;

  async function next(): Promise<void> {
    while (index < items.length) {
      const current = index;
      index += 1;
      const item = items[current];
      if (!item) continue;
      try {
        const value = await worker(item);
        results[current] = { status: "fulfilled", value };
      } catch (reason) {
        results[current] = { status: "rejected", reason };
        console.error("[Lifecycle] Character update failed", reason);
      }
    }
  }

  const size = Math.min(concurrency, items.length);
  if (size > 0) {
    await Promise.all(Array.from({ length: size }, () => next()));
  }
  return results;
}

export async function updateCharacterState(
  characterId: string,
  worldEvents: WorldEvent[]
): Promise<{ initiated: boolean }> {
  const character = await prisma.character.findUnique({
    where: { id: characterId },
    select: { id: true, name: true, publicMemory: true },
  });

  if (!character) {
    throw new Error("Персонаж не найден");
  }

  const publicMemory = memoryToText(character.publicMemory) || "память пуста";
  const prompt = `Ты персонаж ${character.name}. Вот твоя публичная память: ${publicMemory}. Вот события в мире: ${formatWorldEvents(worldEvents)}. Что ты делаешь сейчас? Ответь кратко (одно предложение).`;

  const action = await completeLifecyclePrompt(prompt, 80);
  if (!isSafeAction(action)) {
    console.log(`[Lifecycle] Unsafe or empty action skipped character=${characterId}`);
    await prisma.character.update({
      where: { id: characterId },
      data: { lastActive: new Date() },
    });
    return { initiated: false };
  }

  const location = extractLocation(action);
  const event = await prisma.worldEvent.create({
    data: {
      characterId,
      initiatorId: characterId,
      type: "action",
      participants: [characterId],
      description: action,
      importance: 1,
      location,
    },
  });

  await prisma.character.update({
    where: { id: characterId },
    data: { lastActive: new Date() },
  });

  console.log(
    `[Lifecycle] Updated character=${characterId} event=${event.id} location=${location ?? "none"} action="${action}"`
  );

  const initiated = await maybeInitiateInteraction(characterId);
  return { initiated };
}

export async function maybeInitiateInteraction(characterId: string): Promise<boolean> {
  if (Math.random() >= INITIATE_CHANCE) {
    return false;
  }

  const character = await prisma.character.findUnique({
    where: { id: characterId },
    select: { id: true, name: true, publicMemory: true },
  });

  if (!character) {
    return false;
  }

  const peers = await prisma.character.findMany({
    where: { isPublic: true, id: { not: characterId } },
    select: { id: true, name: true, publicMemory: true },
    orderBy: { lastActive: "desc" },
    take: 20,
  });

  if (peers.length === 0) {
    console.log(`[CharacterEcho] No peers for character=${characterId}`);
    return false;
  }

  const peer = peers[Math.floor(Math.random() * peers.length)];
  if (!peer) {
    return false;
  }
  const publicMemory = memoryToText(character.publicMemory) || "память пуста";
  const peerMemory = memoryToText(peer.publicMemory) || "память пуста";
  const prompt = `Ты персонаж ${character.name}. Публичная память: ${publicMemory}. Рядом находится персонаж ${peer.name}. Его публичная память: ${peerMemory}. Инициируй безопасное доброжелательное взаимодействие: короткое обращение, приглашение или совместное мирное действие. Одно предложение.`;

  const action = await completeLifecyclePrompt(prompt, 80);
  if (!isSafeAction(action)) {
    console.log(`[CharacterEcho] Unsafe initiate skipped character=${characterId}`);
    return false;
  }

  const event = await prisma.worldEvent.create({
    data: {
      characterId,
      initiatorId: characterId,
      type: "conversation",
      participants: [characterId, peer.id],
      description: action,
      importance: 2,
      location: extractLocation(action),
    },
  });

  console.log(
    `[CharacterEcho] Initiated character=${characterId} peer=${peer.id} event=${event.id} action="${action}"`
  );

  return true;
}

export async function loadRecentWorldEvents(characterId: string): Promise<WorldEvent[]> {
  return prisma.worldEvent.findMany({
    where: {
      OR: [{ characterId }, { initiatorId: characterId }, { participants: { has: characterId } }],
    },
    orderBy: { timestamp: "desc" },
    take: MAX_EVENTS_IN_PROMPT,
  });
}

export async function runCharacterLifecycleTick(
  options: { limit?: number } = {}
): Promise<LifecycleTickSummary> {
  const limit = options.limit ?? LIFECYCLE_BATCH_LIMIT;
  const since = new Date(Date.now() - LIFECYCLE_ACTIVE_WINDOW_MS);

  const rows = (await prisma.character.findMany({
    where: { lastActive: { gt: since } },
    select: { id: true },
    orderBy: { lastActive: "desc" },
    take: limit,
  })) as Array<{ id: string }>;

  const characterIds: string[] = rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  console.log(
    `[Lifecycle] Tick start candidates=${characterIds.length} since=${since.toISOString()} concurrency=${LIFECYCLE_CONCURRENCY}`
  );

  const results = await runPool(
    characterIds,
    LIFECYCLE_CONCURRENCY,
    async (characterId: string) => {
      const events = await loadRecentWorldEvents(characterId);
      return updateCharacterState(characterId, events);
    }
  );

  const updated = results.filter((result) => result.status === "fulfilled").length;
  const errors = results.filter((result) => result.status === "rejected").length;
  const initiated = results.filter(
    (result) => result.status === "fulfilled" && result.value.initiated
  ).length;

  const summary = { checked: characterIds.length, updated, errors, initiated };
  console.log("[Lifecycle] Tick finished", summary);
  return summary;
}

export async function withActivityStatus<T extends { id: string; name: string }>(
  characters: T[]
): Promise<Array<T & { activityStatus: string | null; lastActive: Date | null }>> {
  if (characters.length === 0) {
    return [];
  }

  const ids = characters.map((character) => character.id);
  const [events, lastActiveRows] = await Promise.all([
    prisma.worldEvent.findMany({
      where: {
        type: { in: ["action", "conversation", "travel"] },
        OR: [{ characterId: { in: ids } }, { initiatorId: { in: ids } }],
      },
      orderBy: { timestamp: "desc" },
      take: ids.length * 4,
      select: {
        characterId: true,
        initiatorId: true,
        description: true,
        location: true,
        timestamp: true,
      },
    }),
    prisma.character.findMany({
      where: { id: { in: ids } },
      select: { id: true, lastActive: true },
    }),
  ]);

  const latestByCharacter = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    const ownerIds = [event.characterId, event.initiatorId].filter(
      (value): value is string => Boolean(value)
    );
    for (const ownerId of ownerIds) {
      if (!latestByCharacter.has(ownerId)) {
        latestByCharacter.set(ownerId, event);
      }
    }
  }

  const lastActiveById = new Map(lastActiveRows.map((row) => [row.id, row.lastActive]));

  return characters.map((character) => {
    const event = latestByCharacter.get(character.id);
    return {
      ...character,
      lastActive: lastActiveById.get(character.id) ?? null,
      activityStatus: formatCharacterStatus(character.name, event ?? null),
    };
  });
}
