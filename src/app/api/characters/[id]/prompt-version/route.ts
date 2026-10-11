import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isPromptV2Enabled } from "@/lib/promptState";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    const { id } = await params;
    const body = await req.json();
    if (body?.confirmed !== true || ![1, 2].includes(body?.version)) return NextResponse.json({ error: "Подтвердите выбор версии" }, { status: 400 });
    if (body.version === 2 && !isPromptV2Enabled()) return NextResponse.json({ error: "Новая сборка пока не включена оператором" }, { status: 409 });
    const result = await prisma.$transaction(async tx => {
      const card = await tx.character.findUnique({ where: { id } });
      if (!card || card.userId !== session.user.id) return null;
      return tx.character.update({ where: { id }, data: {
        promptBuilderVersion: body.version,
        ...(body.version === 2 && card.legacyPromptArchive === null ? { legacyPromptArchive: card.systemPrompt } : {}),
      }, select: { promptBuilderVersion: true, legacyPromptArchive: true, promptOrigin: true } });
    });
    if (!result) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    errorLog("PromptVersion", "Card switch failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось сменить сборку" }, { status: 500 });
  }
}
