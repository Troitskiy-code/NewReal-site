import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SUBSCRIPTION_PLANS } from "@/lib/chatEconomy";
import { buildReceipt, generateRobokassaPaymentUrl } from "@/lib/robokassa";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const body = await req.json();
    const planId = typeof body?.planId === "string" ? body.planId.trim() : "";
    const period = body?.period === "year" ? "year" : body?.period === "month" ? "month" : "";
    const applyMode =
      body?.applyMode === "afterExpiry" ? "afterExpiry" : body?.applyMode === "immediate" ? "immediate" : "";

    if (body?.recurringConsent !== true) {
      return NextResponse.json(
        { error: "Для оформления подписки необходимо согласие на автосписания" },
        { status: 400 }
      );
    }

    if (!planId || !period || !applyMode) {
      return NextResponse.json({ error: "planId, period и applyMode обязательны" }, { status: 400 });
    }

    const plan = SUBSCRIPTION_PLANS.find((item) => item.id === planId);
    if (!plan || plan.monthlyPrice <= 0) {
      return NextResponse.json({ error: "Тариф не найден" }, { status: 400 });
    }

    if (applyMode === "afterExpiry") {
      const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { subscriptionType: true, subscriptionEnd: true },
      });
      if (!user || !isSubscriptionActive(user)) {
        return NextResponse.json(
          { error: "Отложенная подписка доступна только при активном тарифе" },
          { status: 400 }
        );
      }
    }

    const sum = period === "year" ? plan.yearlyPrice : plan.monthlyPrice;
    const periodLabel = period === "year" ? "год" : "месяц";
    const desc = `Подписка ${plan.name} на 1 ${periodLabel}`;

    const receipt = buildReceipt([{ name: `Подписка ${plan.name} на 1 ${periodLabel}`, price: sum, quantity: 1 }]);
    const url = generateRobokassaPaymentUrl(
      session.user.id,
      sum,
      desc,
      {
        Shp_subscription: "true",
        Shp_plan: plan.id,
        Shp_period: period,
        Shp_applyMode: applyMode,
      },
      receipt,
      { period, amount: sum }
    );

    return NextResponse.json({ url });
  } catch (error) {
    console.error("Subscription payment creation error:", error);
    return NextResponse.json({ error: "Ошибка создания платежа" }, { status: 500 });
  }
}
