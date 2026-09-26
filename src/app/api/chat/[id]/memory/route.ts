import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
import { getChatMemoryPayload } from "@/lib/advancedMemory";

export async function GET(
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

    const access = await getAuthorizedCharacterForChat(session.user.id, characterId);
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const isOwner = access.character.userId === session.user.id;
    const includeLowImportance = isOwner && req.nextUrl.searchParams.get("all") === "1";
    const payload = await getChatMemoryPayload(session.user.id, characterId, {
      includeLowImportance,
    });
    console.log(
      `[MemoryEditor] loaded character=${characterId} summary=${payload.summary ? "yes" : "no"} core=${payload.core ? "yes" : "no"} episodic=${payload.episodic.length} all=${includeLowImportance}`
    );
    return NextResponse.json({ ...payload, isOwner });
  } catch (error) {
    console.error("[MemoryEditor] Get chat memory error:", error);
    return NextResponse.json({ error: "Не удалось загрузить память" }, { status: 500 });
  }
}
