import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PUT(req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await context.params;
    const { content } = await req.json();

    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "content обязателен" }, { status: 400 });
    }

    const message = await prisma.message.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        role: true,
      },
    });

    if (!message) {
      return NextResponse.json({ error: "Сообщение не найдено" }, { status: 404 });
    }

    if (message.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    if (message.role !== "user") {
      return NextResponse.json({ error: "Можно редактировать только сообщения пользователя" }, { status: 400 });
    }

    const updatedMessage = await prisma.message.update({
      where: { id: message.id },
      data: { content: content.trim() },
    });

    return NextResponse.json(updatedMessage);
  } catch (error) {
    console.error("Update message error:", error);
    return NextResponse.json({ error: "Не удалось обновить сообщение" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await context.params;

    const message = await prisma.message.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        characterId: true,
      },
    });

    if (!message) {
      return NextResponse.json({ error: "Сообщение не найдено" }, { status: 404 });
    }

    if (message.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    await prisma.message.delete({
      where: { id: message.id },
    });

    return NextResponse.json({
      success: true,
      deletedId: message.id,
      characterId: message.characterId,
    });
  } catch (error) {
    console.error("Delete message error:", error);
    return NextResponse.json({ error: "Не удалось удалить сообщение" }, { status: 500 });
  }
}
