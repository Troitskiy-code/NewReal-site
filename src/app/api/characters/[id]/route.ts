import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseCharacterBody } from "@/lib/characterFields";
import { translateCharacterFieldsToEn } from "@/lib/translate";
type RouteContext = {
  params: Promise<{ id: string }>;
};

async function getAuthorizedCharacter(id: string, userId: string) {
  const character = await prisma.character.findUnique({ where: { id } });

  if (!character) {
    return { error: NextResponse.json({ error: "Персонаж не найден" }, { status: 404 }) };
  }

  if (character.userId !== userId) {
    return { error: NextResponse.json({ error: "Доступ запрещён" }, { status: 403 }) };
  }

  return { character };
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const session = await getServerSession(authOptions);

    const character = await prisma.character.findUnique({ where: { id } });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    const isOwner = Boolean(session?.user?.id && session.user.id === character.userId);

    if (!isOwner && !character.isPublic) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    return NextResponse.json(character);
  } catch (error) {
    console.error("Character fetch error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await context.params;
    const authResult = await getAuthorizedCharacter(id, session.user.id);
    if (authResult.error) return authResult.error;

    const body = await req.json();

    let parsed;
    try {
      parsed = parseCharacterBody(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Некорректные данные";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const data: {
      name?: string;
      description?: string | null;
      descriptionCard?: string | null;
      appearance?: string | null;
      tags?: string | null;
      imageUrl?: string | null;
      imageLora?: string | null;
      greeting?: string | null;
      scenario?: string | null;
      exampleDialogs?: string | null;
      avatarPrompt?: string | null;
      isPublic?: boolean;
      name_en?: string | null;
      description_en?: string | null;
      appearance_en?: string | null;
      greeting_en?: string | null;
      scenario_en?: string | null;
      exampleDialogs_en?: string | null;
      avatarPrompt_en?: string | null;
    } = {};

    if (body.name !== undefined) {
      if (!parsed.name) {
        return NextResponse.json({ error: "Имя обязательно" }, { status: 400 });
      }
      data.name = parsed.name;
    }

    if (body.description !== undefined) data.description = parsed.description ?? null;
    if (body.descriptionCard !== undefined) data.descriptionCard = parsed.descriptionCard ?? null;
    if (body.appearance !== undefined) data.appearance = parsed.appearance ?? null;
    if (body.tags !== undefined) data.tags = parsed.tags ?? null;
    if (body.imageUrl !== undefined) data.imageUrl = parsed.imageUrl ?? null;
    if (body.imageLora !== undefined) data.imageLora = parsed.imageLora ?? null;
    if (body.greeting !== undefined) data.greeting = parsed.greeting ?? null;
    if (body.scenario !== undefined) data.scenario = parsed.scenario ?? null;
    if (body.exampleDialogs !== undefined) data.exampleDialogs = parsed.exampleDialogs ?? null;
    if (body.avatarPrompt !== undefined) data.avatarPrompt = parsed.avatarPrompt ?? null;
    if (body.isPublic !== undefined) data.isPublic = parsed.isPublic;
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Нет полей для обновления" }, { status: 400 });
    }

    try {
      const translations = await translateCharacterFieldsToEn({
        ...(body.name !== undefined ? { name: parsed.name } : {}),
        ...(body.description !== undefined ? { description: data.description } : {}),
        ...(body.appearance !== undefined ? { appearance: data.appearance } : {}),
        ...(body.greeting !== undefined ? { greeting: data.greeting } : {}),
        ...(body.scenario !== undefined ? { scenario: data.scenario } : {}),
        ...(body.exampleDialogs !== undefined ? { exampleDialogs: data.exampleDialogs } : {}),
        ...(body.avatarPrompt !== undefined ? { avatarPrompt: data.avatarPrompt } : {}),
      });
      Object.assign(data, translations);
    } catch (translateError) {
      console.error("[Translate] Failed to update character translations", translateError);
    }

    const character = await prisma.character.update({
      where: { id },
      data,
    });

    return NextResponse.json(character);
  } catch (error) {
    console.error("Character update error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await context.params;
    const authResult = await getAuthorizedCharacter(id, session.user.id);
    if (authResult.error) return authResult.error;

    await prisma.character.delete({ where: { id } });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("Character delete error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
