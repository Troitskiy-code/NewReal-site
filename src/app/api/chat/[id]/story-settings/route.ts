import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrCreateThreadPromptState, initialPromptState } from "@/lib/promptState";
import { ROLEPLAY_MODES, roleplayMode, validateGroupConfig, type RoleplayMode } from "@/lib/roleplayConfig";
import { ClientInputError } from "@/lib/publicError";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { requestedThreadId, resolveChatScope, threadPromptScopeKey } from "@/lib/chatThreads";

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
async function handle(req: NextRequest, characterId: string, write: boolean) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return reply({ error: "Не авторизован" }, 401);
    const card = await prisma.character.findUnique({ where: { id: characterId }, select: { userId: true, isPublic: true, roleplayMode: true, rpConfig: true } });
    if (!card || (!card.isPublic && card.userId !== session.user.id)) return reply({ error: "Доступ запрещён" }, 403);
    let body: { mode?: unknown; version?: unknown } | null = null;
    if (write) {
      try { body = await req.json(); } catch { return reply({ error: "Некорректные настройки" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body) || body.version !== undefined || !ROLEPLAY_MODES.includes(body.mode as RoleplayMode)) return reply({ error: "Выберите тип истории" }, 400);
    }
    // Settings belong to one story. Choosing a type before the first message creates that story.
    const resolution = await resolveChatScope(session.user.id, characterId, requestedThreadId(req), { create: write });
    if (resolution.status === "not_found") return reply({ error: "История не найдена" }, 404);
    if (!write) {
      const state = resolution.status === "found" ? await getOrCreateThreadPromptState(resolution.scope) : initialPromptState(card);
      return reply({ mode: state.mode });
    }
    if (resolution.status !== "found" || !body) throw new Error("Story was not created");
    const scopeKey = threadPromptScopeKey(resolution.scope.threadId);
    const mode = body.mode as RoleplayMode;
    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Character" WHERE "id" = ${characterId} FOR SHARE`;
      const current = await tx.character.findUnique({ where: { id: characterId }, select: { userId: true, isPublic: true, rpConfig: true } });
      if (!current || (!current.isPublic && current.userId !== session.user.id)) return reply({ error: "Доступ запрещён" }, 403);
      validateGroupConfig(mode, current.rpConfig);
      const state = { builderVersion: 2, mode: roleplayMode(mode) };
      const updated = await tx.chatPromptState.upsert({ where: { scopeKey_characterId: { scopeKey, characterId } },
        create: { scopeKey, characterId, ...state }, update: state });
      return reply({ mode: updated.mode });
    });
  } catch (error) {
    if (error instanceof ClientInputError) return reply({ error: error.message }, 400);
    errorLog("StorySettings", "Update failed", toSafeDiagnostic(error));
    return reply({ error: "Не удалось обновить настройки истории" }, 500);
  }
}
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { return handle(req, (await params).id, false); }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { return handle(req, (await params).id, true); }
