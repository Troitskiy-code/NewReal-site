import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
import { setSummaryContent } from "@/lib/advancedMemory";

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
    const summary = body?.summary ?? body?.content;
    if (typeof summary !== "string") {
      return NextResponse.json({ error: "summary обязателен" }, { status: 400 });
    }

    const access = await getAuthorizedCharacterForChat(session.user.id, characterId);
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const saved = await setSummaryContent(session.user.id, characterId, summary);
    return NextResponse.json({
      summary: saved
        ? { summary: saved.summary, createdAt: saved.createdAt }
        : null,
    });
  } catch (error) {
    console.error("[MemoryEditor] summary save failed", error);
    return NextResponse.json({ error: "Не удалось сохранить суммаризацию" }, { status: 500 });
  }
}
