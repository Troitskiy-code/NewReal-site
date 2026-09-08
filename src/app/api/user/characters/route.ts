import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CHARACTERS_PAGE_LIMIT } from "@/lib/charactersList";
import { ensureCharacterSlugColumn, isMissingSlugColumn } from "@/lib/ensureCharacterSlug";

const profileCharacterSelectNoSlug = {
  id: true,
  name: true,
  name_en: true,
  description: true,
  description_en: true,
  descriptionCard: true,
  tags: true,
  imageUrl: true,
  isPublic: true,
  totalMessages: true,
  createdAt: true,
} as const;

const profileCharacterSelect = {
  ...profileCharacterSelectNoSlug,
  slug: true,
} as const;

let userIdIndexPromise: Promise<void> | null = null;

function ensureUserIdIndexes() {
  if (!userIdIndexPromise) {
    userIdIndexPromise = (async () => {
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "Character_userId_idx" ON "Character"("userId")`
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "Character_userId_createdAt_idx" ON "Character"("userId", "createdAt")`
      );
    })().catch((error) => {
      userIdIndexPromise = null;
      throw error;
    });
  }
  return userIdIndexPromise;
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    try {
      await ensureCharacterSlugColumn();
    } catch (error) {
      console.error("[profile] Could not ensure slug column", error);
    }

    try {
      await ensureUserIdIndexes();
    } catch (error) {
      console.error("[profile] Could not ensure userId indexes", error);
    }

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const parsedLimit = parseInt(searchParams.get("limit") || String(CHARACTERS_PAGE_LIMIT), 10);
    const limit = Math.min(
      48,
      Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : CHARACTERS_PAGE_LIMIT)
    );
    const skip = (page - 1) * limit;
    const sort = searchParams.get("sort") === "top" ? "top" : "new";
    const orderBy =
      sort === "top" ? { totalMessages: "desc" as const } : { createdAt: "desc" as const };

    const where = { userId: session.user.id };
    const startedAt = Date.now();
    const total = await prisma.character.count({ where });

    const loadCharacters = (
      select: typeof profileCharacterSelect | typeof profileCharacterSelectNoSlug
    ) =>
      prisma.character.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        select,
      });

    let characters;
    try {
      characters = await loadCharacters(profileCharacterSelect);
    } catch (error) {
      if (!isMissingSlugColumn(error)) throw error;
      console.error("[profile] Listing without slug column");
      characters = await loadCharacters(profileCharacterSelectNoSlug);
    }

    let favoriteIds = new Set<string>();
    if (characters.length > 0) {
      const favorites = await prisma.favorite.findMany({
        where: {
          userId: session.user.id,
          characterId: { in: characters.map((character) => character.id) },
        },
        select: { characterId: true },
      });
      favoriteIds = new Set(favorites.map((favorite) => favorite.characterId));
    }

    const data = characters.map((character) => ({
      ...character,
      isFavorited: favoriteIds.has(character.id),
    }));

    console.log(
      `[profile] GET ${Date.now() - startedAt}ms page=${page} limit=${limit} sort=${sort} total=${total} returned=${data.length}`
    );

    return NextResponse.json({
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("[profile] Error fetching characters:", error);
    return NextResponse.json({ error: "Ошибка получения списка персонажей" }, { status: 500 });
  }
}
