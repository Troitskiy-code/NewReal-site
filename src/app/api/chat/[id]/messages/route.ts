import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { clearChatMemories } from "@/lib/advancedMemory";
import { getAuthorizedChatScope } from "@/lib/chatAccess";
import { messageScopeWhere, requestedThreadId, threadPromptScopeKey } from "@/lib/chatThreads";

/** Clears the messages and memory of one story; the story itself and other stories remain. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id: characterId } = await params;

    const access = await getAuthorizedChatScope(session.user.id, characterId, requestedThreadId(req));
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (access.resolution.status !== "found") {
      return NextResponse.json({ success: true, deletedCount: 0 });
    }
    const { scope } = access.resolution;
    const where = messageScopeWhere(scope);

    const messagesToClear = await prisma.message.findMany({
      where,
      select: { id: true },
    });

    const messageIds = messagesToClear.map((message) => message.id);

    if (messageIds.length > 0) {
      await prisma.messageEmbedding.deleteMany({
        where: { messageId: { in: messageIds } },
      });
    }

    // totalMessages не уменьшаем: это накопительный счётчик по всем пользователям.
    const result = await prisma.message.deleteMany({ where });

    await clearChatMemories(scope);
    // An explicit restart is the only operation that re-adopts the card's default mode.
    await prisma.chatPromptState.deleteMany({
      where: {
        characterId,
        scopeKey: { in: [threadPromptScopeKey(scope.threadId), ...(scope.legacy ? [`user:${session.user.id}`] : [])] },
      },
    });

    return NextResponse.json({
      success: true,
      deletedCount: result.count,
    });
  } catch (error) {
    errorLog("Server", "Clear chat error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось очистить чат" }, { status: 500 });
  }
}
