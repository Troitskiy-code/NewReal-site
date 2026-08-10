import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    const models = await prisma.model.findMany({
      where: { isActive: true },
      orderBy: { pricePer1MInput: "asc" },
      select: {
        id: true,
        name: true,
        displayName: true,
        pricePer1MInput: true,
        pricePer1MOutput: true,
        isFreeForSubscribers: true,
        isActive: true,
      },
    });

    let selectedModelId: string | null = null;
    let isSubscribed = false;

    if (session?.user?.id) {
      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { selectedModelId: true, isSubscribed: true },
      });
      selectedModelId = user?.selectedModelId ?? null;
      isSubscribed = user?.isSubscribed ?? false;
    }

    return NextResponse.json({
      models,
      selectedModelId,
      isSubscribed,
    });
  } catch (error) {
    console.error("Models fetch error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
