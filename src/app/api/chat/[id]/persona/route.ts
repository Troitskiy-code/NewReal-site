import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAuthorizedCharacterForChat } from "@/lib/chatAccess";
import { assignPersonaToChat, getSelectedChatPersona } from "@/lib/personaService";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id: characterId } = await context.params;
    const access = await getAuthorizedCharacterForChat(session.user.id, characterId);
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const persona = await getSelectedChatPersona(session.user.id, characterId);
    return NextResponse.json({ persona });
  } catch (error) {
    console.error("[Persona] get chat persona failed", error);
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
    const access = await getAuthorizedCharacterForChat(session.user.id, characterId);
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const body = await req.json();
    const personaId = typeof body?.personaId === "string" ? body.personaId.trim() : "";
    if (!personaId) {
      return NextResponse.json({ error: "personaId обязателен" }, { status: 400 });
    }

    const result = await assignPersonaToChat(session.user.id, characterId, personaId);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("[Persona] attach failed", error);
    return NextResponse.json({ error: "Не удалось выбрать личность" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id: characterId } = await context.params;
    const access = await getAuthorizedCharacterForChat(session.user.id, characterId);
    if ("error" in access) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    await prisma.personaSelection.deleteMany({
      where: { userId: session.user.id, characterId },
    });

    console.log(`[Persona] detached user=${session.user.id} character=${characterId}`);
    return NextResponse.json({ persona: null, success: true });
  } catch (error) {
    console.error("[Persona] detach failed", error);
    return NextResponse.json({ error: "Не удалось сбросить личность" }, { status: 500 });
  }
}
