import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_SUBSCRIPTION_TYPE,
  SUBSCRIPTION_PLANS,
  getSubscriptionActivationBenefits,
  getSubscriptionPlan,
} from "@/lib/chatEconomy";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";
import {
  addSubscriptionDays,
  applyPendingSubscriptionIfDue,
  serializeSubscriptionState,
  subscriptionPeriodDays,
} from "@/lib/subscriptionState";
import { applySubscriptionCoinGrant } from "@/lib/verseCoins";

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const body = await req.json();
    const rawPlanId = typeof body?.planId === "string" ? body.planId.trim().toLowerCase() : "";
    const applyMode = body?.applyMode;
    const period = body?.period === "year" ? "year" : "month";

    if (!rawPlanId || (applyMode !== "immediate" && applyMode !== "afterExpiry")) {
      return NextResponse.json(
        { error: "planId и applyMode обязательны" },
        { status: 400 }
      );
    }

    const plan = SUBSCRIPTION_PLANS.find((item) => item.id === rawPlanId)
      ?? (rawPlanId === "history" ? SUBSCRIPTION_PLANS.find((item) => item.id === "story") : undefined);
    if (!plan) {
      return NextResponse.json({ error: "Тариф не найден" }, { status: 400 });
    }

    const userId = session.user.id;
    await applyPendingSubscriptionIfDue(userId);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionType: true,
        subscriptionEnd: true,
        pendingSubscriptionType: true,
        pendingSubscriptionEnd: true,
        isSubscribed: true,
        robokassaRecurringId: true,
        verseCoins: true,
        permanentCoins: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    const now = new Date();
    const currentPlan = getSubscriptionPlan(user.subscriptionType);
    const active = isSubscriptionActive(user);

    if (applyMode === "immediate") {
      const isStart = plan.id === DEFAULT_SUBSCRIPTION_TYPE || plan.monthlyPrice <= 0;
      const benefits = getSubscriptionActivationBenefits(plan, now);
      const coinData = applySubscriptionCoinGrant(
        { id: userId, verseCoins: user.verseCoins, permanentCoins: user.permanentCoins },
        benefits.vcGrant,
        isStart
      );
      const updated = await prisma.$transaction(async (tx) => {
        const nextUser = await tx.user.update({
          where: { id: userId },
          data: {
            subscriptionType: isStart ? DEFAULT_SUBSCRIPTION_TYPE : plan.id,
            subscriptionEnd: isStart ? null : addSubscriptionDays(now, subscriptionPeriodDays(period)),
            isSubscribed: !isStart,
            pendingSubscriptionType: null,
            pendingSubscriptionEnd: null,
            ...benefits.user,
            ...coinData,
          },
          select: {
            subscriptionType: true,
            subscriptionEnd: true,
            pendingSubscriptionType: true,
            pendingSubscriptionEnd: true,
            isSubscribed: true,
            robokassaRecurringId: true,
          },
        });

        await tx.transaction.create({
          data: {
            userId,
            amount: benefits.transaction.amount,
            type: benefits.transaction.type,
            description: `Смена подписки на «${plan.name}» (сразу). ${benefits.transaction.description}`,
          },
        });

        return nextUser;
      });

      return NextResponse.json(serializeSubscriptionState(updated, now));
    }

    if (!active || !user.subscriptionEnd) {
      return NextResponse.json(
        { error: "Отложенная смена доступна только при активной подписке" },
        { status: 400 }
      );
    }

    if (currentPlan.id === plan.id) {
      return NextResponse.json(
        { error: "Этот тариф уже активен" },
        { status: 400 }
      );
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        pendingSubscriptionType: plan.id,
        pendingSubscriptionEnd: user.subscriptionEnd,
      },
      select: {
        subscriptionType: true,
        subscriptionEnd: true,
        pendingSubscriptionType: true,
        pendingSubscriptionEnd: true,
        isSubscribed: true,
        robokassaRecurringId: true,
      },
    });

    return NextResponse.json(serializeSubscriptionState(updated, now));
  } catch (error) {
    console.error("Subscription change error:", error);
    return NextResponse.json({ error: "Не удалось изменить подписку" }, { status: 500 });
  }
}
