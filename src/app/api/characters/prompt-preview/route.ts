import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseCharacterBody } from "@/lib/characterFields";
import { assembleRoleplayPrompt, fitPromptAssembly, PromptBudgetError } from "@/lib/chatSystemPrompt";
import { countTokens } from "@/lib/tokenCount";
import { promptAssemblyDiagnostics } from "@/lib/promptDiagnostics";
import { chatModelGenerationOptions } from "@/lib/testingChatModels";
import { resolveChatPreviewContext, resolveContextTokenBudget } from "@/lib/chatHelpers";
import { isPromptV2Enabled } from "@/lib/promptState";
import { getApiLocale } from "@/lib/apiI18n";
import { ClientInputError } from "@/lib/publicError";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ClientInputError("Некорректная карточка");
    if (body.characterId !== undefined) {
      if (typeof body.characterId !== "string") throw new ClientInputError("Некорректный ID");
      const card = await prisma.character.findUnique({ where: { id: body.characterId }, select: { userId: true } });
      if (!card || card.userId !== session.user.id) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }
    const parsed = parseCharacterBody(body);
    // Preview treats these as current fields, rather than an old persisted translation.
    const context = await resolveChatPreviewContext(session.user.id);
    const budget = context ? resolveContextTokenBudget(context.user, context.model) : 6000;
    const assembly = fitPromptAssembly(assembleRoleplayPrompt(parsed, getApiLocale(req)), Math.floor(budget * 0.5), countTokens);
    return NextResponse.json({ ...assembly, diagnostics: promptAssemblyDiagnostics(assembly),
      rolloutEnabled: isPromptV2Enabled(), modelName: context?.model.name ?? null,
      parameters: context ? chatModelGenerationOptions(context.model.name) : null,
      scope: "card-preview-without-conversation-memory-or-history",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ClientInputError || error instanceof PromptBudgetError) return NextResponse.json({ error: error.message }, { status: 400 });
    errorLog("PromptPreview", "Preview failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось собрать инструкции" }, { status: 500 });
  }
}
