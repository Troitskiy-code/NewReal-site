import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
import { consumeRateLimit } from "@/lib/rateLimit";
import {
  chatThreadsEnabled,
  createChatThread,
  isValidThreadId,
  normalizeThreadTitle,
  toThreadSummary,
} from "@/lib/chatThreads";

type RouteContext = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "private, no-store" };
// Not a limit on how many stories exist; it only stops scripted bulk creation of empty rows.
const CREATE_LIMIT = 30;
const CREATE_WINDOW_MS = 10 * 60_000;

async function authorize(characterId: string) {
  // Stories off: the endpoints do not exist, exactly as before the feature.
  if (!chatThreadsEnabled()) return { response: NextResponse.json({ error: "Не найдено" }, { status: 404 }) };
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return { response: NextResponse.json({ error: "Не авторизован" }, { status: 401 }) };
  const access = await getAuthorizedCharacterForChat(session.user.id, characterId);
  if ("error" in access) return { response: NextResponse.json({ error: access.error }, { status: access.status }) };
  return { userId: session.user.id };
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const { id: characterId } = await context.params;
    const auth = await authorize(characterId);
    if ("response" in auth) return auth.response;

    const threads = await prisma.chatThread.findMany({
      where: { userId: auth.userId, characterId },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    });
    const counts = threads.length === 0 ? [] : await (prisma.message.groupBy({
      by: ["threadId"],
      where: { userId: auth.userId, characterId, threadId: { in: threads.map((thread) => thread.id) } },
      _count: { id: true },
    }) as Promise<Array<{ threadId: string | null; _count: { id: number } }>>);
    const countByThread = new Map(counts.map((row) => [row.threadId, row._count.id]));
    return NextResponse.json(
      { threads: threads.map((thread) => toThreadSummary(thread, countByThread.get(thread.id) ?? 0)) },
      { headers: NO_STORE }
    );
  } catch (error) {
    errorLog("Server", "[Threads] list failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось загрузить истории" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const { id: characterId } = await context.params;
    const auth = await authorize(characterId);
    if ("response" in auth) return auth.response;

    const body = await req.json().catch(() => ({})) as { title?: unknown; sourceThreadId?: unknown };
    const title = body?.title === undefined ? null : normalizeThreadTitle(body.title);
    if (title === undefined) return NextResponse.json({ error: "Некорректное название истории" }, { status: 400 });
    let sourceThreadId: string | null = null;
    if (body?.sourceThreadId !== undefined && body.sourceThreadId !== null) {
      const source = isValidThreadId(body.sourceThreadId)
        ? await prisma.chatThread.findFirst({ where: { id: body.sourceThreadId, userId: auth.userId, characterId }, select: { id: true } })
        : null;
      if (!source) return NextResponse.json({ error: "История не найдена" }, { status: 404 });
      sourceThreadId = source.id;
    }

    const limit = await consumeRateLimit(`chat-thread-create:${auth.userId}`, CREATE_LIMIT, CREATE_WINDOW_MS);
    if (limit.ok === false) {
      return NextResponse.json({ error: "Слишком много новых историй подряд. Попробуйте чуть позже." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } });
    }

    // Empty memory; greeting and opening situation come from the card on the first message.
    const thread = await createChatThread({ userId: auth.userId, characterId, title, sourceThreadId });
    console.log(`[Threads] created character=${characterId} number=${thread.number}`);
    return NextResponse.json({ thread: toThreadSummary(thread, 0) }, { status: 201, headers: NO_STORE });
  } catch (error) {
    errorLog("Server", "[Threads] create failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось создать историю" }, { status: 500 });
  }
}
