import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseCharacterBody } from "@/lib/characterFields";
import { isCharacterSort, DEFAULT_CHARACTER_SORT } from "@/lib/characterSort";

// ------------------ POST (создание персонажа) ------------------
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const body = await req.json();

    let parsed;
    try {
      parsed = parseCharacterBody(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Некорректные данные";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const {
      name,
      description,
      descriptionCard,
      appearance,
      tags,
      imageUrl,
      imageLora,
      isPublic,
      greeting,
      scenario,
      exampleDialogs,
      avatarPrompt,
    } = parsed;

    if (!name) {
      return NextResponse.json({ error: "Имя обязательно" }, { status: 400 });
    }

    const character = await prisma.character.create({
      data: {
        name,
        description: description ?? null,
        descriptionCard: descriptionCard ?? null,
        appearance: appearance ?? null,
        tags: tags ?? null,
        imageUrl: imageUrl ?? null,
        imageLora: imageLora ?? null,
        greeting: greeting ?? null,
        scenario: scenario ?? null,
        exampleDialogs: exampleDialogs ?? null,
        avatarPrompt: avatarPrompt ?? null,
        isPublic,
        userId: session.user.id,
      },
    });

    return NextResponse.json(character, { status: 201 });
  } catch (error) {
    console.error("Character creation error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}

// ------------------ GET (получение списка персонажей) ------------------
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search") || "";
    const tagsParam = searchParams.get("tags") || "";
    const tagParam = searchParams.get("tag") || "";
    const tagList = [
      ...searchParams.getAll("tags"),
      ...tagsParam.split(",").map((t) => t.trim()),
      ...searchParams.getAll("tag"),
      ...tagParam.split(",").map((t) => t.trim()),
    ].filter(Boolean);
    const uniqueTags = [...new Set(tagList)];
    const userId = searchParams.get("userId") || "";
    const isPublic =
      searchParams.get("isPublic") === "true"
        ? true
        : searchParams.get("isPublic") === "false"
          ? false
          : undefined;
    const sortParam = searchParams.get("sort") || DEFAULT_CHARACTER_SORT;
    const sort = isCharacterSort(sortParam) ? sortParam : DEFAULT_CHARACTER_SORT;
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = parseInt(searchParams.get("limit") || "24", 10);
    const skip = (page - 1) * limit;

    const session = await getServerSession(authOptions);

    const where: Record<string, unknown> = {};

    if (userId) {
      where.userId = userId;

      if (!session?.user?.id || session.user.id !== userId) {
        where.isPublic = true;
      }
    } else if (isPublic === undefined) {
      where.isPublic = true;
    } else {
      where.isPublic = isPublic;
    }

    const andConditions: Record<string, unknown>[] = [{ ...where }];

    if (search) {
      andConditions.push({
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { tags: { contains: search, mode: "insensitive" } },
        ],
      });
    }

    if (uniqueTags.length > 0) {
      andConditions.push({
        OR: uniqueTags.map((tag) => ({
          tags: { contains: tag, mode: "insensitive" },
        })),
      });
    }

    const queryWhere = andConditions.length === 1 ? andConditions[0] : { AND: andConditions };

    const userInclude = {
      user: {
        select: {
          name: true,
          image: true,
        },
      },
    };

    let characters;
    const total = await prisma.character.count({ where: queryWhere });

    if (sort === "random") {
      const ids = await prisma.character.findMany({
        where: queryWhere,
        select: { id: true },
      });
      const shuffled = [...ids].sort(() => Math.random() - 0.5);
      const pageIds = shuffled.slice(skip, skip + limit).map((row) => row.id);

      if (pageIds.length === 0) {
        characters = [];
      } else {
        const rows = await prisma.character.findMany({
          where: { id: { in: pageIds } },
          include: userInclude,
        });
        const byId = new Map(rows.map((row) => [row.id, row]));
        characters = pageIds.map((id) => byId.get(id)).filter(Boolean);
      }
    } else {
      const orderBy =
        sort === "top" || sort === "for-you"
          ? { messages: { _count: "desc" as const } }
          : { createdAt: "desc" as const };

      characters = await prisma.character.findMany({
        where: queryWhere,
        orderBy,
        skip,
        take: limit,
        include: userInclude,
      });
    }

    let favoriteIds = new Set<string>();
    if (session?.user?.id) {
      const favorites = await prisma.favorite.findMany({
        where: { userId: session.user.id },
        select: { characterId: true },
      });
      favoriteIds = new Set(favorites.map((favorite) => favorite.characterId));
    }

    const data = characters.map((character) => ({
      ...character,
      isFavorited: favoriteIds.has(character.id),
    }));

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
    console.error("Error fetching characters:", error);
    return NextResponse.json({ error: "Ошибка получения списка персонажей" }, { status: 500 });
  }
}