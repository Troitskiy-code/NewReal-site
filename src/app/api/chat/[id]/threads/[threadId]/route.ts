import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
import {
  chatThreadsEnabled,
  isValidThreadId,
  normalizeThreadTitle,
  threadPromptScopeKey,
  toThreadSummary,
} from "@/lib/chatThreads";

type RouteContext = { params: Promise<{ id: string; threadId: string }> };
const NO_STORE = { "Cache-Control": "private, no-store" };
const NOT_FOUND = "История не найдена";

/** Same 404 for a malformed, deleted, foreign or other-character story: existence is not revealed. */
async function authorizeThread(characterId: string, threadId: string) {
  if (!chatThreadsEnabled()) return { response: NextResponse.json({ error: "Не найдено" }, { status: 404 }) };
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return { response: NextResponse.json({ error: "Не авторизован" }, { status: 401 }) };
  const access = await getAuthorizedCharacterForChat(session.user.id, characterId);
  if ("error" in access) return { response: NextResponse.json({ error: access.error }, { status: access.status }) };
  const thread = isValidThreadId(threadId)
    ? await prisma.chatThread.findFirst({ where: { id: threadId, userId: session.user.id, characterId } })
    : null;
  if (!thread) return { response: NextResponse.json({ error: NOT_FOUND }, { status: 404 }) };
  return { thread };
}

/** Rename ({ title }, null = automatic) and archive/restore ({ status }). */
export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const { id: characterId, threadId } = await context.params;
    const auth = await authorizeThread(characterId, threadId);
    if ("response" in auth) return auth.response;

    const body = await req.json().catch(() => null) as { title?: unknown; status?: unknown } | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
    const data: { title?: string | null; status?: string } = {};
    if (body.title !== undefined) {
      const title = normalizeThreadTitle(body.title);
      if (title === undefined) return NextResponse.json({ error: "Некорректное название истории" }, { status: 400 });
      data.title = title;
    }
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "archived") {
        return NextResponse.json({ error: "Некорректный статус истории" }, { status: 400 });
      }
      data.status = body.status;
    }
    if (!Object.keys(data).length) return NextResponse.json({ error: "Нечего изменять" }, { status: 400 });

    const thread = await prisma.chatThread.update({ where: { id: auth.thread.id }, data });
    return NextResponse.json({ thread: toThreadSummary(thread) }, { headers: NO_STORE });
  } catch (error) {
    errorLog("Server", "[Threads] update failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось изменить историю" }, { status: 500 });
  }
}

/** Irreversible: messages, their embeddings and the story's memory go with it ({ confirmed: true }). */
export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const { id: characterId, threadId } = await context.params;
    const auth = await authorizeThread(characterId, threadId);
    if ("response" in auth) return auth.response;

    const body = await req.json().catch(() => null) as { confirmed?: unknown } | null;
    if (body?.confirmed !== true) {
      return NextResponse.json({ error: "Подтвердите удаление истории" }, { status: 400 });
    }

    const deletedMessages = await prisma.message.count({ where: { threadId: auth.thread.id } });
    // Messages, embeddings (via Message), summary, core, episodes and entries cascade from the story.
    await prisma.$transaction([
      prisma.chatPromptState.deleteMany({ where: { scopeKey: threadPromptScopeKey(auth.thread.id), characterId } }),
      prisma.chatThread.delete({ where: { id: auth.thread.id } }),
    ]);
    // totalMessages is a cumulative counter across users and is never decreased.
    console.log(`[Threads] deleted character=${characterId} messages=${deletedMessages}`);
    return NextResponse.json({ success: true, deletedMessages }, { headers: NO_STORE });
  } catch (error) {
    errorLog("Server", "[Threads] delete failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось удалить историю" }, { status: 500 });
  }
}
