import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { tryGenerateCharacterPrompt } from "@/lib/generateCharacterPrompt";
import { memoryToText } from "@/lib/persistentMemory";

export const maxDuration = 60;

type RouteContext = {
  params: Promise<{ id: string }>;
};

function textOrStored(value: unknown, stored: unknown): string {
  if (typeof value === "string") return value;
  return memoryToText(stored);
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { id } = await context.params;
    const character = await prisma.character.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        name: true,
        appearance: true,
        description: true,
        scenario: true,
        exampleDialogs: true,
        publicMemory: true,
        privateMemory: true,
      },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    if (character.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : character.name;
    const appearance =
      typeof body.appearance === "string" ? body.appearance : character.appearance;
    const description =
      typeof body.description === "string" ? body.description : character.description;
    const scenario = typeof body.scenario === "string" ? body.scenario : character.scenario;
    const exampleDialogs =
      typeof body.exampleDialogs === "string" ? body.exampleDialogs : character.exampleDialogs;
    const publicMemory = textOrStored(body.publicMemory, character.publicMemory);
    const privateMemory = textOrStored(body.privateMemory, character.privateMemory);

    console.log(
      `[CharacterPrompt] regenerate character=${character.id} user=${session.user.id} hasPublic=${Boolean(publicMemory.trim())} hasPrivate=${Boolean(privateMemory.trim())}`
    );

    const systemPrompt = await tryGenerateCharacterPrompt({
      name,
      appearance,
      description,
      scenario,
      exampleDialogs,
      publicMemory,
      privateMemory,
    });

    if (!systemPrompt) {
      return NextResponse.json(
        { error: "Не удалось сгенерировать системный промпт" },
        { status: 502 }
      );
    }

    await prisma.character.update({
      where: { id: character.id },
      data: { systemPrompt },
    });

    return NextResponse.json({ systemPrompt });
  } catch (error) {
    console.error("[CharacterPrompt] regenerate-prompt failed", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
