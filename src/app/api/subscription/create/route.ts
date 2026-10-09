import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SUBSCRIPTION_PLANS } from "@/lib/chatEconomy";
import { buildReceipt, buildRobokassaSuccessUrl, createRobokassaCheckout } from "@/lib/robokassa";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";
import { rejectUnverifiedEmail } from "@/lib/emailVerification";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { metrikaPlanSlug } from "@/lib/metrika";
import { reportPaymentFailure } from "@/lib/safeDiagnostics";
import { registerPaymentOrder } from "@/lib/paymentOrders";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const unverified = await rejectUnverifiedEmail(req, session.user.id, "api.confirmEmailToPurchase");
    if (unverified) return unverified;

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

    console.log("[Consent] recurring subscription", {
      userId: session.user.id,
      planId,
      period,
    });

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

    const sumRUB = period === "year" ? plan.yearlyPrice : plan.monthlyPrice;
    const periodLabel = period === "year" ? "год" : "месяц";
    const desc = `Подписка ${plan.name} на 1 ${periodLabel}`;

    const receipt = buildReceipt([{ name: `Подписка ${plan.name} на 1 ${periodLabel}`, price: sumRUB, quantity: 1 }]);
    console.log("[Subscription] Creating recurring payment:", {
      period,
      amount: sumRUB,
      currency: "RUB",
      amountRUB: sumRUB,
    });
    const locale = await getRequestLocale();
    const successUrl2 = buildRobokassaSuccessUrl("/pricing", locale, {
      payment: "success",
      type: "subscription",
      plan: metrikaPlanSlug(plan.id),
    });
    const checkout = createRobokassaCheckout({
      userId: session.user.id,
      sum: sumRUB,
      desc,
      extraShp: {
        Shp_subscription: "true",
        Shp_type: "subscription",
        Shp_plan: plan.id,
        Shp_period: period,
        Shp_applyMode: applyMode,
      },
      receipt,
      recurring: { period, amount: sumRUB },
      successUrl2,
      email: session.user.email,
      locale,
    });

    await registerPaymentOrder({ invoiceId: checkout.fields.InvId, userId: session.user.id,
      kind: "subscription", amountRub: sumRUB, planId: plan.id, period, attribution: body?.attribution });
    return NextResponse.json(checkout);
  } catch (error) {
    reportPaymentFailure("subscription.create", error);
    return NextResponse.json({ error: "Ошибка создания платежа" }, { status: 500 });
  }
}
