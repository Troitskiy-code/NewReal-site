import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const userId = session.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const [charactersCount, uniqueChats, messagesCount] = await Promise.all([
      prisma.character.count({ where: { userId } }),
      prisma.message.findMany({
        where: { userId },
        distinct: ["characterId"],
        select: { characterId: true },
      }),
      prisma.message.count({ where: { userId } }),
    ]);

    return NextResponse.json({
      charactersCount,
      chatsCount: uniqueChats.length,
      messagesCount,
      createdAt: user.createdAt,
    });
  } catch (error) {
    console.error("User stats error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
