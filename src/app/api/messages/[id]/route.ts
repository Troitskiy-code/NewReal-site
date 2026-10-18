import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invalidateMessageMemory, lockMemoryThread } from "@/lib/memoryV2";

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
        characterId: true,
        threadId: true,
      },
    });

    if (!message) {
      return NextResponse.json({ error: "Сообщение не найдено" }, { status: 404 });
    }

    if (message.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const updatedMessage = message.threadId ? await prisma.$transaction(async tx => {
      const scope = { userId: message.userId, characterId: message.characterId, threadId: message.threadId!, legacy: false };
      await lockMemoryThread(tx, scope.threadId);
      await invalidateMessageMemory(tx, scope, message.id);
      return tx.message.update({ where: { id: message.id }, data: { content: content.trim(), finishReason: null } });
    }) : await prisma.message.update({
      where: { id: message.id },
      // The provider's termination describes the generated text, not a manual edit.
      data: { content: content.trim(), finishReason: null },
    });

    return NextResponse.json(updatedMessage);
  } catch (error) {
    errorLog("Server", "Update message error:", toSafeDiagnostic(error));
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
        threadId: true,
      },
    });

    if (!message) {
      return NextResponse.json({ error: "Сообщение не найдено" }, { status: 404 });
    }

    if (message.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    if (message.threadId) await prisma.$transaction(async tx => {
      const scope = { userId: message.userId, characterId: message.characterId, threadId: message.threadId!, legacy: false };
      await lockMemoryThread(tx, scope.threadId);
      await invalidateMessageMemory(tx, scope, message.id, true);
      await tx.message.delete({ where: { id: message.id } });
    });
    else await prisma.message.delete({
      where: { id: message.id },
    });

    return NextResponse.json({
      success: true,
      deletedId: message.id,
      characterId: message.characterId,
    });
  } catch (error) {
    errorLog("Server", "Delete message error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось удалить сообщение" }, { status: 500 });
  }
}
