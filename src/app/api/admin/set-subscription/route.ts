import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const ALLOWED_SUBSCRIPTION_TYPES = new Set(["start", "dialog", "story", "history", "universe"]);

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return false;
  }

  const authHeader = req.headers.get("Authorization");
  return authHeader === `Bearer ${adminSecret}`;
}

function normalizeSubscriptionType(rawType: string): string | null {
  const normalized = rawType.trim().toLowerCase();
  if (normalized === "history") {
    return "story";
  }
  return normalized;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json();
    const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const rawSubscriptionType =
      typeof body?.subscriptionType === "string" ? body.subscriptionType.trim().toLowerCase() : "";

    if (!userId && !email) {
      return NextResponse.json({ error: "Укажите userId или email" }, { status: 400 });
    }

    if (!rawSubscriptionType || !ALLOWED_SUBSCRIPTION_TYPES.has(rawSubscriptionType)) {
      return NextResponse.json(
        { error: "subscriptionType должен быть: start, dialog, history, universe" },
        { status: 400 }
      );
    }

    const subscriptionType = normalizeSubscriptionType(rawSubscriptionType);
    if (!subscriptionType) {
      return NextResponse.json({ error: "Некорректный subscriptionType" }, { status: 400 });
    }

    const user = userId
      ? await prisma.user.findUnique({ where: { id: userId } })
      : await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const now = new Date();
    const isStartPlan = subscriptionType === "start";

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionType: isStartPlan ? "start" : subscriptionType,
        subscriptionEnd: isStartPlan ? null : addDays(now, 30),
        isSubscribed: !isStartPlan,
      },
      select: {
        id: true,
        email: true,
        subscriptionType: true,
        subscriptionEnd: true,
        isSubscribed: true,
        verseCoins: true,
      },
    });

    console.log(
      `🛡️ Admin subscription: user=${updatedUser.id}, type=${updatedUser.subscriptionType}, end=${updatedUser.subscriptionEnd?.toISOString() ?? "null"}`
    );

    return NextResponse.json({
      userId: updatedUser.id,
      email: updatedUser.email,
      subscriptionType: updatedUser.subscriptionType,
      subscriptionEnd: updatedUser.subscriptionEnd,
      isSubscribed: updatedUser.isSubscribed,
      verseCoins: updatedUser.verseCoins,
    });
  } catch (error) {
    console.error("Admin set-subscription error:", error);
    return NextResponse.json({ error: "Ошибка назначения подписки" }, { status: 500 });
  }
}
