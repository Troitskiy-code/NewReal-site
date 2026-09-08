import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
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

    const access = await getAuthorizedCharacterForChat(session.user.id, characterId);
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const created = await addEpisodicMemory(session.user.id, characterId, event, importance);
    if (!created) {
      return NextResponse.json({ error: "Не удалось добавить событие" }, { status: 400 });
    }

    console.log(
      `[MemoryEditor] episodic added id=${created.id} character=${characterId} importance=${created.importance}`
    );
    return NextResponse.json({ episodic: created }, { status: 201 });
  } catch (error) {
    console.error("[MemoryEditor] episodic add failed", error);
    return NextResponse.json({ error: "Не удалось добавить событие" }, { status: 500 });
  }
}
