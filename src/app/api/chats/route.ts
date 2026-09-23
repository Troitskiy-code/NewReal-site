import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { characterAvatarPath } from "@/lib/characterCardImage";
import { isMissingSlugColumn } from "@/lib/ensureCharacterSlug";

const LAST_MESSAGE_PREVIEW = 150;

const characterSelectNoSlug = {
  id: true,
  name: true,
  name_en: true,
  description: true,
  description_en: true,
  descriptionCard: true,
  updatedAt: true,
} as const;

const characterSelect = {
  ...characterSelectNoSlug,
  slug: true,
} as const;

type ChatCharacterRow = {
  id: string;
  name: string;
  name_en: string | null;
  slug?: string | null;
  description: string | null;
  description_en: string | null;
  descriptionCard: string | null;
  updatedAt: Date;
};

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const userId = session.user.id;
    const t0 = performance.now();

    const groups = await prisma.message.groupBy({
      by: ["characterId"],
      where: { userId },
      _count: { id: true },
      _max: { createdAt: true },
    });

    if (groups.length === 0) {
      console.log("[Chats] query", (performance.now() - t0).toFixed(0), "ms, count: 0");
      return NextResponse.json({ data: [] });
    }

    const characterIds = groups.map((group) => group.characterId);
    const lastMessageOr = groups
      .filter((group) => group._max.createdAt)
      .map((group) => ({
        characterId: group.characterId,
        createdAt: group._max.createdAt as Date,
      }));

    let characters: ChatCharacterRow[];
    try {
      characters = await prisma.character.findMany({
        where: { id: { in: characterIds } },
        select: characterSelect,
      });
    } catch (error) {
      if (!isMissingSlugColumn(error)) throw error;
      console.error("[Chats] Listing without slug column");
      characters = await prisma.character.findMany({
        where: { id: { in: characterIds } },
        select: characterSelectNoSlug,
      });
    }

    const lastMessages =
      lastMessageOr.length === 0
        ? []
        : await prisma.message.findMany({
            where: { userId, OR: lastMessageOr },
            select: {
              id: true,
              characterId: true,
              role: true,
              content: true,
              createdAt: true,
            },
          });

    console.log(
      "[Chats] query",
      (performance.now() - t0).toFixed(0),
      "ms, count:",
      groups.length
    );

    const characterById = new Map(characters.map((character) => [character.id, character]));
    const lastByCharacter = new Map<string, (typeof lastMessages)[number]>();
    for (const message of lastMessages) {
      const existing = lastByCharacter.get(message.characterId);
      if (!existing || message.createdAt > existing.createdAt) {
        lastByCharacter.set(message.characterId, message);
      }
    }

    const data = groups
      .map((group) => {
        const character = characterById.get(group.characterId);
        const lastMessage = lastByCharacter.get(group.characterId);
        if (!character || !lastMessage) return null;

        return {
          character: {
            id: character.id,
            name: character.name,
            name_en: character.name_en,
            slug: character.slug ?? null,
            description: character.description,
            description_en: character.description_en,
            descriptionCard: character.descriptionCard,
            updatedAt: character.updatedAt,
            imageUrl: characterAvatarPath(character.id, character.updatedAt),
          },
          lastMessage: {
            id: lastMessage.id,
            role: lastMessage.role,
            content: lastMessage.content.slice(0, LAST_MESSAGE_PREVIEW),
            createdAt: lastMessage.createdAt,
          },
          count: group._count.id,
          lastActivity: group._max.createdAt ?? lastMessage.createdAt,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row != null)
      .sort(
        (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
      );

    return NextResponse.json({ data });
  } catch (error) {
    console.error("Chats GET error:", error);
    return NextResponse.json({ error: "Ошибка получения чатов" }, { status: 500 });
  }
}
