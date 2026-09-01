import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { renewSubscriptionIfDue } from "@/lib/subscriptionRenewal";

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return false;
  }

  const authHeader = req.headers.get("Authorization");
  return authHeader === `Bearer ${adminSecret}`;
}

function skipMessage(reason: string): string {
  switch (reason) {
    case "user_not_found":
      return "Пользователь не найден";
    case "no_recurring_id":
      return "У пользователя нет robokassaRecurringId";
    case "no_subscription_end":
      return "У пользователя нет даты окончания подписки";
    case "pending_plan_change":
      return "Продление пропущено: есть отложенная смена тарифа";
    case "free_plan":
      return "Продление пропущено: бесплатный тариф";
    case "not_due":
      return "Подписка ещё не истекла";
    case "already_initiated":
      return "Продление уже было запущено недавно";
    case "charge_failed":
      return "Не удалось списать рекуррентный платёж в Robokassa";
    default:
      return "Не удалось продлить подписку";
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json();
    const userId = typeof body?.userId === "string" ? body.userId.trim() : "";

    if (!userId) {
      return NextResponse.json({ error: "userId обязателен" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, robokassaRecurringId: true },
    });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    if (!user.robokassaRecurringId) {
      return NextResponse.json(
        { error: "У пользователя нет robokassaRecurringId" },
        { status: 400 }
      );
    }

    console.log(`[Admin] Test recurring for user ${userId}`);

    const result = await renewSubscriptionIfDue(userId, { force: true });

    if (!result.renewed) {
      const status = result.reason === "charge_failed" ? 502 : 400;
      return NextResponse.json(
        { success: false, error: skipMessage(result.reason), reason: result.reason },
        { status }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Подписка продлена",
      newSubscriptionEnd: result.newEnd.toISOString(),
      invId: result.invId,
      period: result.period,
    });
  } catch (error) {
    console.error("[Admin] Test recurring error:", error);
    return NextResponse.json({ error: "Ошибка тестового продления" }, { status: 500 });
  }
}
