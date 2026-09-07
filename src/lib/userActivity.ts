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
  const lastSeen = asDate(user.lastSeen);

  const activityAgg = await prisma.character.aggregate({
    where: { userId },
    _max: { lastActive: true },
  });
  const maxLastActive = asDate(activityAgg._max.lastActive);
  const activityAt = maxLastActive ?? lastSeen ?? now;
  const hoursAway = (now.getTime() - activityAt.getTime()) / (1000 * 60 * 60);

  console.log(
    `[LoginEvents] maxLastActive: ${maxLastActive?.toISOString() ?? "null"}, hoursAway: ${hoursAway.toFixed(2)} user=${userId} lastSeen=${lastSeen?.toISOString() ?? "null"} threshold=${INACTIVITY_THRESHOLD_HOURS}`
  );

  const shouldGenerate = hoursAway > INACTIVITY_THRESHOLD_HOURS;
  const lastSeenAgeMs = lastSeen ? now.getTime() - lastSeen.getTime() : Number.POSITIVE_INFINITY;
  if (shouldGenerate || lastSeenAgeMs >= 5 * 60 * 1000) {
    await prisma.user.update({
      where: { id: userId },
      data: { lastSeen: now },
    });
  }

  if (!shouldGenerate) {
    return;
  }

  const awayHours = Math.min(hoursAway, 24);

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
