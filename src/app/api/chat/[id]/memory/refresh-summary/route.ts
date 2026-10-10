import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { withAiCostContext, setAiCostActor } from "@/lib/aiCostTelemetry";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
import { refreshMemorySummaryWithStatus, rebuildMemorySummaryStep, MemorySummaryInputError, MemoryRebuildCursorError } from "@/lib/chatMemory";
import { consumeRateLimit } from "@/lib/rateLimit";

const KODIKROUTER_KEY = process.env.KODIKROUTER_API_KEY ?? "";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withAiCostContext(() => handleCostedRequest(req, context));
}

async function handleCostedRequest(
  req: NextRequest,
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

    const bodyText = await req.text();
    if (bodyText.length > 32_000) return NextResponse.json({ error: "Запрос слишком большой" }, { status: 413 });
    let body: { mode?: unknown; confirm?: unknown; continuation?: unknown } = {};
    try {
      if (bodyText.trim()) body = JSON.parse(bodyText);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
    } catch { return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 }); }
    if (body.mode !== undefined && body.mode !== "refresh" && body.mode !== "rebuild") {
      return NextResponse.json({ error: "Некорректный режим" }, { status: 400 });
    }
    if (body.mode === "rebuild" && (body.confirm !== true || (body.continuation !== undefined && typeof body.continuation !== "string"))) {
      return NextResponse.json({ error: "Подтвердите замену сводки" }, { status: 400 });
    }
    if (body.mode === "rebuild") {
      const limit = await consumeRateLimit(`memory-rebuild:${session.user.id}`, 60, 15 * 60_000);
      if (limit.ok === false) return NextResponse.json({ error: "Слишком много запросов пересборки. Попробуйте позже." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { subscriptionType: true, subscriptionEnd: true },
    });

    setAiCostActor(session.user.id, user?.subscriptionType ?? "start");
    const result = body.mode === "rebuild" ? await rebuildMemorySummaryStep(session.user.id, characterId,
      KODIKROUTER_KEY, user ?? {}, body.continuation as string | undefined) : await refreshMemorySummaryWithStatus(
      session.user.id,
      characterId,
      KODIKROUTER_KEY,
      user ?? undefined
    );
    if (result.status === "empty") {
      return NextResponse.json(
        { error: "Недостаточно сообщений для суммаризации" },
        { status: 400 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MemoryRebuildCursorError) {
      return NextResponse.json({ error: "Пересборка устарела или прервана. Начните заново." }, { status: 400 });
    }
    if (error instanceof MemorySummaryInputError) {
      return NextResponse.json({ error: "Фрагмент переписки слишком велик для безопасной обработки. Прежняя сводка сохранена." }, { status: 422 });
    }
    errorLog("Server", "Refresh memory summary error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось обновить суммаризацию" }, { status: 500 });
  }
}
