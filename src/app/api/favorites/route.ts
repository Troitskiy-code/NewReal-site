import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const characterSelect = {
  id: true,
  name: true,
  description: true,
  descriptionCard: true,
  appearance: true,
  tags: true,
  imageUrl: true,
  isPublic: true,
  totalMessages: true,
  createdAt: true,
  user: {
    select: {
      name: true,
      image: true,
    },
  },
} as const;

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const favorites = await prisma.favorite.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      include: {
        character: {
          select: characterSelect,
        },
      },
    });

    return NextResponse.json({
      data: favorites.map((favorite) => ({
        ...favorite.character,
        isFavorited: true,
        favoritedAt: favorite.createdAt,
      })),
    });
  } catch (error) {
    console.error("Favorites GET error:", error);
    return NextResponse.json({ error: "Ошибка получения избранного" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const body = await req.json();
    const characterId = typeof body.characterId === "string" ? body.characterId.trim() : "";
    const action = body.action;

    if (!characterId) {
      return NextResponse.json({ error: "characterId обязателен" }, { status: 400 });
    }

    if (action !== "add" && action !== "remove") {
      return NextResponse.json({ error: "action должен быть add или remove" }, { status: 400 });
    }

    const character = await prisma.character.findUnique({
      where: { id: characterId },
      select: { id: true, isPublic: true, userId: true },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    if (!character.isPublic && character.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    if (action === "add") {
      await prisma.favorite.upsert({
        where: {
          userId_characterId: {
            userId: session.user.id,
            characterId,
          },
        },
        create: {
          userId: session.user.id,
          characterId,
        },
        update: {},
      });

      return NextResponse.json({ isFavorited: true });
    }

    await prisma.favorite.deleteMany({
      where: {
        userId: session.user.id,
        characterId,
      },
    });

    return NextResponse.json({ isFavorited: false });
  } catch (error) {
    console.error("Favorites POST error:", error);
    return NextResponse.json({ error: "Ошибка обновления избранного" }, { status: 500 });
  }
}
