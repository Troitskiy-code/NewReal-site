import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
import { setCoreMemoryContent } from "@/lib/advancedMemory";

export async function PUT(
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
    const content = body?.content;
    if (typeof content !== "string") {
      return NextResponse.json({ error: "content обязателен" }, { status: 400 });
    }

    const access = await getAuthorizedCharacterForChat(session.user.id, characterId);
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const coreMemory = await setCoreMemoryContent(session.user.id, characterId, content);
    console.log("[MemoryEditor] User updated memory.");
    return NextResponse.json({ coreMemory });
  } catch (error) {
    console.error("Update core memory error:", error);
    return NextResponse.json({ error: "Не удалось сохранить ключевую память" }, { status: 500 });
  }
}
