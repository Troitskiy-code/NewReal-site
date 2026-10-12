import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAuthorizedChatScope } from "@/lib/chatAccess";
import { requestedThreadId } from "@/lib/chatThreads";
import { assignPersonaToChat, clearChatPersona, getSelectedChatPersona } from "@/lib/personaService";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id: characterId } = await context.params;
    const access = await getAuthorizedChatScope(session.user.id, characterId, requestedThreadId(req));
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    // Before the first story exists this is the persona it will start with.
    const threadId = access.resolution.status === "found" ? access.resolution.scope.threadId : null;
    const persona = await getSelectedChatPersona(session.user.id, characterId, threadId);
    return NextResponse.json({ persona });
  } catch (error) {
    errorLog("Server", "[Persona] get chat persona failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось загрузить личность" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id: characterId } = await context.params;
    const body = await req.json();
    const personaId = typeof body?.personaId === "string" ? body.personaId.trim() : "";
    if (!personaId) {
      return NextResponse.json({ error: "personaId обязателен" }, { status: 400 });
    }

    const access = await getAuthorizedChatScope(session.user.id, characterId, requestedThreadId(req), { create: true });
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }
    if (access.resolution.status !== "found") throw new Error("Story was not created");

    const result = await assignPersonaToChat(access.resolution.scope, personaId);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(result);
  } catch (error) {
    errorLog("Server", "[Persona] attach failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось выбрать личность" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id: characterId } = await context.params;
    const access = await getAuthorizedChatScope(session.user.id, characterId, requestedThreadId(req));
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    if (access.resolution.status === "found") await clearChatPersona(access.resolution.scope);
    else await prisma.personaSelection.deleteMany({ where: { userId: session.user.id, characterId } });

    console.log(`[Persona] detached user=${session.user.id} character=${characterId}`);
    return NextResponse.json({ persona: null, success: true });
  } catch (error) {
    errorLog("Server", "[Persona] detach failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось сбросить личность" }, { status: 500 });
  }
}
