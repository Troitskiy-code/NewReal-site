import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const modelId = body?.modelId;

    if (!modelId || typeof modelId !== "string") {
      return NextResponse.json({ error: "modelId обязателен" }, { status: 400 });
    }

    const model = await prisma.model.findFirst({
      where: { id: modelId, isActive: true },
      select: {
        id: true,
        name: true,
        displayName: true,
        priceVC: true,
        maxContextTokens: true,
      },
    });

    if (!model) {
      return NextResponse.json({ error: "Модель не найдена" }, { status: 400 });
    }

    const user = await prisma.user.update({
      where: { id: session.user.id },
      data: { selectedModelId: modelId },
      select: {
        id: true,
        selectedModelId: true,
        selectedModel: {
          select: {
            id: true,
            name: true,
            displayName: true,
            priceVC: true,
            maxContextTokens: true,
          },
        },
      },
    });

    return NextResponse.json({
      user,
      selectedModelId: user.selectedModelId,
      selectedModel: user.selectedModel,
      message: "Модель выбрана",
    });
  } catch (error) {
    console.error("Select model error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
