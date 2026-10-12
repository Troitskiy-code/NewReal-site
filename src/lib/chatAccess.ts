import { prisma } from "@/lib/prisma";
import { resolveChatScope, type ScopeResolution } from "@/lib/chatThreads";

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

/**
 * Character access plus the story of the request. A foreign, deleted or malformed story is 404
 * and nothing else is read or written. Reads pass create=false and handle "none" as an empty chat;
 * writes pass create=true, so the first one creates the default story.
 */
export async function getAuthorizedChatScope(
  userId: string,
  characterId: string,
  requestedThreadId: string | null,
  options: { create?: boolean } = {}
): Promise<
  | { error: string; status: 403 | 404 }
  | { character: { id: string; isPublic: boolean; userId: string }; resolution: Exclude<ScopeResolution, { status: "not_found" }> }
> {
  const access = await getAuthorizedCharacterForChat(userId, characterId);
  if (!access.character) return { error: access.error, status: access.status };
  const resolution = await resolveChatScope(userId, characterId, requestedThreadId, options);
  if (resolution.status === "not_found") return { error: "История не найдена", status: 404 };
  return { character: access.character, resolution };
}
