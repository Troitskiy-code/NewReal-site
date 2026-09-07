import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const ACTIVITY_TYPES = ["action", "discovery", "travel"] as const;
const ACTIVITY_LIMIT = 10;

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "ID персонажа не указан" }, { status: 400 });
    }

    const character = await prisma.character.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    if (character.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const events = await prisma.worldEvent.findMany({
      where: {
        type: { in: [...ACTIVITY_TYPES] },
        OR: [{ characterId: id }, { initiatorId: id }],
      },
      orderBy: { timestamp: "desc" },
      take: ACTIVITY_LIMIT,
      select: {
        id: true,
        type: true,
        description: true,
        location: true,
        timestamp: true,
        importance: true,
      },
    });

    console.log(`[Lifecycle] Activity report character=${id} user=${session.user.id} events=${events.length}`);

    return NextResponse.json({ events });
  } catch (error) {
    console.error("[Lifecycle] Activity report failed", error);
    return NextResponse.json({ error: "Не удалось загрузить отчёт" }, { status: 500 });
  }
}
