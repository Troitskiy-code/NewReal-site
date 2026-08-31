import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
import { deleteEpisodicMemory } from "@/lib/advancedMemory";

export async function DELETE(
  _req: NextRequest,
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

    const access = await getAuthorizedCharacterForChat(session.user.id, characterId);
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const deleted = await deleteEpisodicMemory(session.user.id, characterId, episodicId);
    if (!deleted) {
      return NextResponse.json({ error: "Событие не найдено" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete episodic memory error:", error);
    return NextResponse.json({ error: "Не удалось удалить событие" }, { status: 500 });
  }
}
