import { prisma } from "@/lib/prisma";

export async function getAuthorizedCharacterForChat(userId: string, characterId: string) {
  const character = await prisma.character.findUnique({
    where: { id: characterId },
    select: { id: true, isPublic: true, userId: true },
  });

  if (!character) {
    return { error: "Персонаж не найден", status: 404 as const };
  }

  if (!character.isPublic && character.userId !== userId) {
    return { error: "Доступ запрещён", status: 403 as const };
  }

  return { character };
}
