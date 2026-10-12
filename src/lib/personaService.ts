import { prisma } from "@/lib/prisma";
import type { ChatPersona } from "@/lib/persona";
import type { ChatScope } from "@/lib/chatThreads";

export function toChatPersona(persona: {
  id: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  isGlobal: boolean;
  characterId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ChatPersona {
  return {
    id: persona.id,
    name: persona.name,
    description: persona.description,
    avatarUrl: persona.avatarUrl,
    isGlobal: persona.isGlobal,
    characterId: persona.characterId,
    createdAt: persona.createdAt.toISOString(),
    updatedAt: persona.updatedAt.toISOString(),
  };
}

export async function getOwnedPersona(userId: string, personaId: string) {
  return prisma.persona.findFirst({
    where: { id: personaId, userId },
  });
}

/**
 * With a story: the persona of that story. Without one (no story yet): the pair's last choice,
 * which is what the first story will copy.
 */
export async function getSelectedChatPersona(
  userId: string,
  characterId: string,
  threadId?: string | null
): Promise<ChatPersona | null> {
  const persona = threadId
    ? (await prisma.chatThread.findFirst({
        where: { id: threadId, userId, characterId },
        select: { persona: true },
      }))?.persona
    : (await prisma.personaSelection.findUnique({
        where: { userId_characterId: { userId, characterId } },
        include: { persona: true },
      }))?.persona;

  if (!persona || persona.userId !== userId) {
    return null;
  }

  return toChatPersona(persona);
}

export async function listUserPersonas(
  userId: string,
  options?: { characterId?: string; isGlobal?: boolean }
) {
  const where: {
    userId: string;
    isGlobal?: boolean;
    OR?: Array<{ isGlobal: boolean } | { characterId: string } | { characterId: null }>;
  } = { userId };

  if (typeof options?.isGlobal === "boolean") {
    where.isGlobal = options.isGlobal;
  } else if (options?.characterId) {
    where.OR = [{ isGlobal: true }, { characterId: options.characterId }];
  }

  const personas = await prisma.persona.findMany({
    where,
    orderBy: [{ isGlobal: "desc" }, { updatedAt: "desc" }],
  });

  return personas.map(toChatPersona);
}

/** Sets the persona of one story; the pair's last choice follows, so a new story copies it. */
export async function assignPersonaToChat(
  scope: ChatScope,
  personaId: string
) {
  const { userId, characterId } = scope;
  const persona = await getOwnedPersona(userId, personaId);
  if (!persona) {
    return { error: "Личность не найдена", status: 404 as const };
  }

  if (!persona.isGlobal && persona.characterId && persona.characterId !== characterId) {
    return { error: "Эта личность доступна только в другом чате", status: 403 as const };
  }

  await prisma.$transaction([
    prisma.chatThread.update({ where: { id: scope.threadId }, data: { personaId } }),
    prisma.personaSelection.upsert({
      where: { userId_characterId: { userId, characterId } },
      create: { userId, characterId, personaId },
      update: { personaId },
    }),
  ]);

  console.log(
    `[Persona] attached user=${userId} character=${characterId} persona=${personaId}`
  );

  return { persona: toChatPersona(persona) };
}

export async function clearChatPersona(scope: ChatScope) {
  await prisma.$transaction([
    prisma.chatThread.update({ where: { id: scope.threadId }, data: { personaId: null } }),
    prisma.personaSelection.deleteMany({ where: { userId: scope.userId, characterId: scope.characterId } }),
  ]);
}
