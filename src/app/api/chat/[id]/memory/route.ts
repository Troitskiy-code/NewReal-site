import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
import { getChatMemoryPayload } from "@/lib/advancedMemory";

export async function GET(
  _req: NextRequest,
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

    const payload = await getChatMemoryPayload(session.user.id, characterId);
    return NextResponse.json(payload);
  } catch (error) {
    console.error("Get chat memory error:", error);
    return NextResponse.json({ error: "Не удалось загрузить память" }, { status: 500 });
  }
}
