import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parsePersonaPayload } from "@/lib/persona";
import { getOwnedPersona, toChatPersona } from "@/lib/personaService";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await context.params;
    const existing = await getOwnedPersona(session.user.id, id);
    if (!existing) {
      return NextResponse.json({ error: "Личность не найдена" }, { status: 404 });
    }

    const body = await req.json();
    const payload = parsePersonaPayload({
      name: body?.name ?? existing.name,
      description: body?.description === undefined ? existing.description : body.description,
      avatarUrl: body?.avatarUrl === undefined ? existing.avatarUrl : body.avatarUrl,
      isGlobal: body?.isGlobal === undefined ? existing.isGlobal : body.isGlobal,
      characterId: body?.characterId === undefined ? existing.characterId : body.characterId,
    });

    const persona = await prisma.persona.update({
      where: { id: existing.id },
      data: {
        name: payload.name,
        description: payload.description,
        avatarUrl: payload.avatarUrl,
        isGlobal: payload.isGlobal,
        characterId: payload.isGlobal ? null : payload.characterId ?? existing.characterId,
      },
    });

    console.log(
      `[Persona] updated user=${session.user.id} id=${persona.id} global=${persona.isGlobal}`
    );

    return NextResponse.json({ persona: toChatPersona(persona) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось обновить личность";
    const status = message === "Имя обязательно" || message.includes("не длиннее") ? 400 : 500;
    if (status === 500) {
      console.error("[Persona] update failed", error);
    }
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await context.params;
    const existing = await getOwnedPersona(session.user.id, id);
    if (!existing) {
      return NextResponse.json({ error: "Личность не найдена" }, { status: 404 });
    }

    await prisma.persona.delete({ where: { id: existing.id } });
    console.log(`[Persona] deleted user=${session.user.id} id=${existing.id}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Persona] delete failed", error);
    return NextResponse.json({ error: "Не удалось удалить личность" }, { status: 500 });
  }
}
