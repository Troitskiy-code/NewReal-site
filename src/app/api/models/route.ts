import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    const models = await prisma.model.findMany({
      where: { isActive: true },
      orderBy: { priceVC: "asc" },
      select: {
        id: true,
        name: true,
        displayName: true,
        pricePer1MInput: true,
        pricePer1MOutput: true,
        priceVC: true,
        description: true,
        isFreeForSubscribers: true,
        isActive: true,
      },
    });

    const baseModel = models[0] ?? null;

    let selectedModelId: string | null = null;
    let subscriptionActive = false;

    if (session?.user?.id) {
      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: {
          selectedModelId: true,
          subscriptionType: true,
          subscriptionEnd: true,
        },
      });
      selectedModelId = user?.selectedModelId ?? null;
      subscriptionActive = user ? isSubscriptionActive(user) : false;
    }

    return NextResponse.json({
      models,
      selectedModelId,
      subscriptionActive,
      baseModelId: baseModel?.id ?? null,
    });
  } catch (error) {
    console.error("Models fetch error:", error);
    return NextResponse.json({ error: "Внутренняя ошибка сервера" }, { status: 500 });
  }
}
