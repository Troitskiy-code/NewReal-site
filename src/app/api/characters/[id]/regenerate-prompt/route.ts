import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { tryGenerateCharacterPrompt } from "@/lib/generateCharacterPrompt";

export const maxDuration = 60;

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_req: NextRequest, context: RouteContext) {
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
      },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    if (character.userId !== session.user.id) {
      return NextResponse.json({ error: "Доступ запрещён" }, { status: 403 });
    }

    const systemPrompt = await tryGenerateCharacterPrompt({
      name: character.name,
      appearance: character.appearance,
      description: character.description,
      scenario: character.scenario,
      exampleDialogs: character.exampleDialogs,
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
