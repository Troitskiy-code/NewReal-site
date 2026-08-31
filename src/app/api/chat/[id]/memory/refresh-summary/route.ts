import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
import { forceRefreshMemorySummary } from "@/lib/chatMemory";

const KODIKROUTER_KEY = process.env.KODIKROUTER_API_KEY ?? "";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    if (!KODIKROUTER_KEY) {
      return NextResponse.json({ error: "KODIKROUTER_API_KEY не настроен" }, { status: 500 });
    }

    const { id: characterId } = await params;
    if (!characterId) {
      return NextResponse.json({ error: "ID персонажа не указан" }, { status: 400 });
    }

    const access = await getAuthorizedCharacterForChat(session.user.id, characterId);
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const summary = await forceRefreshMemorySummary(session.user.id, characterId, KODIKROUTER_KEY);
    if (!summary) {
      return NextResponse.json(
        { error: "Недостаточно сообщений для суммаризации" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      summary: {
        summary,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Refresh memory summary error:", error);
    return NextResponse.json({ error: "Не удалось обновить суммаризацию" }, { status: 500 });
  }
}
