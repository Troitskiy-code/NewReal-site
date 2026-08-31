import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parsePersonaPayload } from "@/lib/persona";
import { assignPersonaToChat, listUserPersonas, toChatPersona } from "@/lib/personaService";

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const characterId = searchParams.get("characterId")?.trim() || undefined;
    const globalParam = searchParams.get("isGlobal");
    const isGlobal =
      globalParam === "true" ? true : globalParam === "false" ? false : undefined;

    const personas = await listUserPersonas(session.user.id, { characterId, isGlobal });
    return NextResponse.json({ personas });
  } catch (error) {
    console.error("[Persona] list failed", error);
    return NextResponse.json({ error: "Не удалось загрузить личности" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const body = await req.json();
    const payload = parsePersonaPayload(body);

    if (payload.characterId) {
      const character = await prisma.character.findUnique({
        where: { id: payload.characterId },
        select: { id: true, isPublic: true, userId: true },
      });
      if (!character) {
        return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
      }
      if (!character.isPublic && character.userId !== session.user.id) {
        return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
      }
    }

    const persona = await prisma.persona.create({
      data: {
        userId: session.user.id,
        name: payload.name,
        description: payload.description,
        avatarUrl: payload.avatarUrl,
        isGlobal: payload.isGlobal,
        characterId: payload.characterId,
      },
    });

    console.log(
      `[Persona] created user=${session.user.id} id=${persona.id} global=${persona.isGlobal}`
    );

    let assigned = false;
    if (payload.characterId) {
      const assignment = await assignPersonaToChat(
        session.user.id,
        payload.characterId,
        persona.id
      );
      assigned = !("error" in assignment);
    }

    return NextResponse.json({ persona: toChatPersona(persona), assigned }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось создать личность";
    const status = message === "Имя обязательно" || message.includes("не длиннее") ? 400 : 500;
    if (status === 500) {
      console.error("[Persona] create failed", error);
    }
    return NextResponse.json({ error: message }, { status });
  }
}
