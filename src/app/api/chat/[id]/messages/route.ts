import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { clearChatMemories } from "@/lib/advancedMemory";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id: characterId } = await params;

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

    const messagesToClear = await prisma.message.findMany({
      where: {
        characterId,
        userId: session.user.id,
      },
      select: { id: true },
    });

    const messageIds = messagesToClear.map((message) => message.id);

    if (messageIds.length > 0) {
      await prisma.messageEmbedding.deleteMany({
        where: { messageId: { in: messageIds } },
      });
    }

    // totalMessages не уменьшаем: это накопительный счётчик по всем пользователям.
    const result = await prisma.message.deleteMany({
      where: {
        characterId,
        userId: session.user.id,
      },
    });

    await clearChatMemories(session.user.id, characterId);

    return NextResponse.json({
      success: true,
      deletedCount: result.count,
    });
  } catch (error) {
    console.error("Clear chat error:", error);
    return NextResponse.json({ error: "Не удалось очистить чат" }, { status: 500 });
  }
}
