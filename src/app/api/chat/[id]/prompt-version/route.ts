import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrCreatePromptState, isPromptV2Enabled } from "@/lib/promptState";
import { ROLEPLAY_MODES, roleplayMode, validateGroupConfig, type RoleplayMode } from "@/lib/roleplayConfig";
import { ClientInputError } from "@/lib/publicError";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { promptRolloutFinalized } from "@/lib/promptRolloutPolicy";

async function handle(req: NextRequest, characterId: string, write: boolean) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    const card = await prisma.character.findUnique({ where: { id: characterId }, select: { userId: true, isPublic: true, promptBuilderVersion: true, roleplayMode: true, rpConfig: true } });
    if (!card || (!card.isPublic && card.userId !== session.user.id)) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    const scopeKey = `user:${session.user.id}`;
    const state = await getOrCreatePromptState(scopeKey, characterId, card);
    if (!write) return NextResponse.json({ ...state, rolloutEnabled: isPromptV2Enabled(), cardVersion: card.promptBuilderVersion }, { headers: { "Cache-Control": "private, no-store" } });
    const body = await req.json();
    if (body?.confirmed !== true || ![1, 2].includes(body?.version) || !ROLEPLAY_MODES.includes(body?.mode as RoleplayMode)) return NextResponse.json({ error: "Подтвердите версию и режим этой истории" }, { status: 400 });
    if (body.mode === "group" && body.version !== 2) return NextResponse.json({ error: "Несколько персонажей доступны только в новой сборке" }, { status: 400 });
    return await prisma.$transaction(async tx => {
      // Validate and write against the same card snapshot as migration/rollback.
      await tx.$queryRaw`SELECT "id" FROM "Character" WHERE "id" = ${characterId} FOR SHARE`;
      const current = await tx.character.findUnique({ where: { id: characterId }, select: { userId: true, isPublic: true, promptBuilderVersion: true, rpConfig: true } });
      if (!current || (!current.isPublic && current.userId !== session.user.id)) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
      if (await promptRolloutFinalized(tx)) return NextResponse.json({ error: "Общий переход завершён. Откат выполняет администратор" }, { status: 409 });
      validateGroupConfig(body.mode, current.rpConfig);
      if (body.version === 2 && (!isPromptV2Enabled() || current.promptBuilderVersion !== 2)) return NextResponse.json({ error: "Владелец карточки или оператор ещё не включил новую сборку" }, { status: 409 });
      const updated = await tx.chatPromptState.update({ where: { scopeKey_characterId: { scopeKey, characterId } }, data: { builderVersion: body.version, mode: roleplayMode(body.mode), promptMigrationId: null } });
      return NextResponse.json({ builderVersion: updated.builderVersion, mode: updated.mode }, { headers: { "Cache-Control": "private, no-store" } });
    });
  } catch (error) {
    if (error instanceof ClientInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    errorLog("PromptVersion", "Story switch failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось обновить настройки истории" }, { status: 500 });
  }
}
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { return handle(req, (await params).id, false); }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { return handle(req, (await params).id, true); }
