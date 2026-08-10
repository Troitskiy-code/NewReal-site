import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const { modelId } = await req.json();
    if (!modelId || typeof modelId !== "string") {
      return NextResponse.json({ error: "modelId обязателен" }, { status: 400 });
    }

    const model = await prisma.model.findFirst({
      where: { id: modelId, isActive: true },
      select: { id: true },
    });

    if (!model) {
      return NextResponse.json({ error: "Модель не найдена" }, { status: 404 });
    }

    const user = await prisma.user.update({
      where: { id: session.user.id },
      data: { selectedModelId: modelId },
      select: { selectedModelId: true },
    });

    return NextResponse.json({
      selectedModelId: user.selectedModelId,
      message: "Модель выбрана",
    });
  } catch (error) {
    console.error("Select model error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
