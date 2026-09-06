import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return false;
  }

  const authHeader = req.headers.get("Authorization");
  return authHeader === `Bearer ${adminSecret}`;
}

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json();
    const characterId = typeof body?.characterId === "string" ? body.characterId.trim() : "";
    const amount = Number(body?.amount);

    if (!characterId) {
      return NextResponse.json({ error: "Укажите characterId" }, { status: 400 });
    }

    if (!Number.isInteger(amount) || amount <= 0) {
      return NextResponse.json(
        { error: "amount должен быть положительным целым числом" },
        { status: 400 }
      );
    }

    const character = await prisma.character.findUnique({
      where: { id: characterId },
      select: { id: true, totalMessages: true },
    });

    if (!character) {
      return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    }

    const updated = await prisma.character.update({
      where: { id: character.id },
      data: { totalMessages: { increment: amount } },
      select: { id: true, totalMessages: true },
    });

    console.log(
      `[Admin:AddMessages] character=${updated.id} +${amount} totalMessages ${character.totalMessages} -> ${updated.totalMessages}`
    );

    return NextResponse.json({
      success: true,
      characterId: updated.id,
      newTotal: updated.totalMessages,
    });
  } catch (error) {
    console.error("[Admin:AddMessages] error:", error);
    return NextResponse.json({ error: "Ошибка увеличения totalMessages" }, { status: 500 });
  }
}
