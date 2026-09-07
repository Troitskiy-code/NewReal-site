import { prisma } from "@/lib/prisma";
import { generateCharacterEvent } from "@/lib/characterLifecycle";
import { memoryToText } from "@/lib/persistentMemory";

const INACTIVITY_THRESHOLD_HOURS = (() => {
  const parsed = parseInt(process.env.USER_INACTIVITY_THRESHOLD_HOURS || "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
})();

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

export async function handleUserLogin(userId: string): Promise<void> {
  if (!userId) return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastSeen: true, id: true },
  });
  if (!user) return;

  const now = new Date();
  const lastSeen = asDate(user.lastSeen) ?? now;
  const hoursAway = (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60);

  if (hoursAway < INACTIVITY_THRESHOLD_HOURS) {
    // Keep lastSeen fresh while the user is active, but avoid a write on every JWT tick.
    const touchAfterMs = 5 * 60 * 1000;
    if (now.getTime() - lastSeen.getTime() >= touchAfterMs) {
      await prisma.user.updateMany({
        where: { id: userId, lastSeen: { lte: lastSeen } },
        data: { lastSeen: now },
      });
    }
    return;
  }

  const claimed = await prisma.user.updateMany({
    where: {
      id: userId,
      lastSeen: { lte: new Date(now.getTime() - INACTIVITY_THRESHOLD_HOURS * 60 * 60 * 1000) },
    },
    data: { lastSeen: now },
  });

  if (claimed.count === 0) {
    return;
  }

  const awayHours = Math.min(hoursAway, 24);
  console.log(
    `[LoginEvents] User returned user=${userId} hoursAway=${hoursAway.toFixed(2)} threshold=${INACTIVITY_THRESHOLD_HOURS}`
  );

  const lastMessage = await prisma.message.findFirst({
    where: { userId, role: "user" },
    orderBy: { createdAt: "desc" },
    select: { characterId: true, chatId: true, createdAt: true },
  });

  if (!lastMessage?.characterId) {
    console.log(`[LoginEvents] No last character for user=${userId}`);
    return;
  }

  const characterId = lastMessage.characterId;
  const character = await prisma.character.findUnique({
    where: { id: characterId },
    select: { name: true, publicMemory: true },
  });

  if (!character) {
    console.log(`[LoginEvents] Character missing character=${characterId} user=${userId}`);
    return;
  }

  const memory = memoryToText(character.publicMemory);
  const prompt = `Ты персонаж ${character.name}. ${memory ? `Твоя память: ${memory}` : ""} Пользователь отсутствовал ${awayHours.toFixed(0)} часов. Что произошло с тобой за это время? Ответь одним предложением (не более 15 слов) от первого лица.`;

  let eventText = "";
  try {
    eventText = await generateCharacterEvent(prompt);
  } catch (error) {
    console.error(`[LoginEvents] AI event failed user=${userId} character=${characterId}`, error);
    return;
  }

  if (!eventText.trim()) {
    console.log(`[LoginEvents] Empty AI event skipped user=${userId} character=${characterId}`);
    return;
  }

  const content = `[Пока тебя не было...] ${eventText.trim()}`;

  await prisma.message.create({
    data: {
      characterId,
      userId,
      chatId: lastMessage.chatId || characterId,
      role: "assistant",
      content,
      createdAt: now,
      isAutoEvent: true,
    },
  });

  await prisma.character.update({
    where: { id: characterId },
    data: { lastActive: now },
  });

  await prisma.worldEvent.create({
    data: {
      characterId,
      initiatorId: characterId,
      type: "auto_event",
      description: eventText.trim(),
      participants: [characterId],
      importance: 1,
      timestamp: now,
    },
  });

  console.log(
    `[LoginEvents] Created return event user=${userId} character=${characterId} hoursAway=${hoursAway.toFixed(2)}`
  );
}
