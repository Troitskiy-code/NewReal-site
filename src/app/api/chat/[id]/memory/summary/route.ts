import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedChatScope } from "@/lib/chatAccess";
import { requestedThreadId } from "@/lib/chatThreads";
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

    const access = await getAuthorizedChatScope(session.user.id, characterId, requestedThreadId(req), { create: true });
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (access.resolution.status !== "found") throw new Error("Story was not created");

    const saved = await setSummaryContent(access.resolution.scope, summary);
    return NextResponse.json({
      summary: saved
        ? { summary: saved.summary, createdAt: saved.createdAt }
        : null,
    });
  } catch (error) {
    errorLog("Server", "[MemoryEditor] summary save failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось сохранить суммаризацию" }, { status: 500 });
  }
}
