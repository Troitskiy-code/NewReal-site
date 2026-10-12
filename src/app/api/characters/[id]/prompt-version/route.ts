import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isPromptV2Enabled } from "@/lib/promptState";
import { validateGroupConfig } from "@/lib/roleplayConfig";
import { ClientInputError } from "@/lib/publicError";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { promptRolloutFinalized } from "@/lib/promptRolloutPolicy";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    if (await promptRolloutFinalized()) return NextResponse.json({ error: "Общий переход завершён. Откат выполняет администратор" }, { status: 409 });
    const { id } = await params;
    const body = await req.json();
    if (body?.confirmed !== true || ![1, 2].includes(body?.version)) return NextResponse.json({ error: "Подтвердите выбор версии" }, { status: 400 });
    if (body.version === 2 && !isPromptV2Enabled()) return NextResponse.json({ error: "Новая сборка пока не включена оператором" }, { status: 409 });
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Character" WHERE "id" = ${id} FOR UPDATE`;
      if (await promptRolloutFinalized(tx)) return { blocked: "Общий переход завершён. Откат выполняет администратор" };
      const card = await tx.character.findUnique({ where: { id } });
      if (!card || card.userId !== session.user.id) return null;
      if (body.version === 1 && await tx.promptMigrationEntry.findFirst({ where: { characterId: id, status: "applied" } })) {
        return { blocked: "Эта карточка переведена администратором. Для возврата карточки нужна кнопка отката в его панели; сравнить старую сборку можно в настройках отдельной истории." };
      }
      if (card.roleplayMode === "group" && body.version === 1) throw new ClientInputError("Групповая карточка требует новой сборки. Сначала смените тип карточки и сохраните её.");
      if (body.version === 2) validateGroupConfig(card.roleplayMode, card.rpConfig);
      return tx.character.update({ where: { id }, data: {
        promptBuilderVersion: body.version,
        ...(body.version === 2 && card.legacyPromptArchive === null ? { legacyPromptArchive: card.systemPrompt } : {}),
      }, select: { promptBuilderVersion: true, legacyPromptArchive: true, promptOrigin: true } });
    });
    if (!result) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    if ("blocked" in result) return NextResponse.json({ error: result.blocked }, { status: 409 });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ClientInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    errorLog("PromptVersion", "Card switch failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось сменить сборку" }, { status: 500 });
  }
}
