import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedChatScope } from "@/lib/chatAccess";
import { requestedThreadId } from "@/lib/chatThreads";
import { addEpisodicMemory, MANUAL_EPISODIC_IMPORTANCE } from "@/lib/advancedMemory";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id: characterId } = await params;
    if (!characterId) {
      return NextResponse.json({ error: "ID персонажа не указан" }, { status: 400 });
    }

    const body = await req.json();
    const event = typeof body?.event === "string" ? body.event : "";
    if (!event.trim()) {
      return NextResponse.json({ error: "event обязателен" }, { status: 400 });
    }

    const requestedImportance =
      typeof body?.importance === "number" ? body.importance : MANUAL_EPISODIC_IMPORTANCE;
    const importance = Math.min(5, Math.max(2, Math.round(requestedImportance)));

    const access = await getAuthorizedChatScope(session.user.id, characterId, requestedThreadId(req), { create: true });
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (access.resolution.status !== "found") throw new Error("Story was not created");

    const created = await addEpisodicMemory(access.resolution.scope, event, importance);
    if (!created) {
      return NextResponse.json({ error: "Не удалось добавить событие" }, { status: 400 });
    }

    console.log(
      `[MemoryEditor] episodic added id=${created.id} character=${characterId} importance=${created.importance}`
    );
    return NextResponse.json({ episodic: created }, { status: 201 });
  } catch (error) {
    errorLog("Server", "[MemoryEditor] episodic add failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось добавить событие" }, { status: 500 });
  }
}
