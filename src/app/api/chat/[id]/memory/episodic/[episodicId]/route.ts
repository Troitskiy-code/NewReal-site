import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedChatScope } from "@/lib/chatAccess";
import { requestedThreadId } from "@/lib/chatThreads";
import { deleteEpisodicMemory } from "@/lib/advancedMemory";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; episodicId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id: characterId, episodicId } = await params;
    if (!characterId || !episodicId) {
      return NextResponse.json({ error: "ID не указан" }, { status: 400 });
    }

    const access = await getAuthorizedChatScope(session.user.id, characterId, requestedThreadId(req));
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const deleted = access.resolution.status === "found"
      && await deleteEpisodicMemory(access.resolution.scope, episodicId);
    if (!deleted) {
      return NextResponse.json({ error: "Событие не найдено" }, { status: 404 });
    }

    console.log(`[MemoryEditor] episodic deleted id=${episodicId} character=${characterId}`);
    return NextResponse.json({ success: true });
  } catch (error) {
    errorLog("Server", "[MemoryEditor] episodic delete failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось удалить событие" }, { status: 500 });
  }
}
