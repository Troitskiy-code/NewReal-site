import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cancelRobokassaRecurring } from "@/lib/robokassa";
import { serializeSubscriptionState } from "@/lib/subscriptionState";

export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        robokassaRecurringId: true,
        subscriptionType: true,
        subscriptionEnd: true,
        pendingSubscriptionType: true,
        pendingSubscriptionEnd: true,
        isSubscribed: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    }

    if (!user.robokassaRecurringId) {
      return NextResponse.json(
        {
          success: true,
          message: "Автопродление отключено",
          ...serializeSubscriptionState({ ...user, robokassaRecurringId: null }),
        }
      );
    }

    const recurringId = user.robokassaRecurringId;
    const cancelled = await cancelRobokassaRecurring(recurringId);
    console.log(
      `[Subscription] Recurring cancel user=${user.id} RecurringID=${recurringId} robokassa=${cancelled ? "ok" : "failed"}; clearing local ID`
    );

    const updated = await prisma.$transaction(async (tx) => {
      const nextUser = await tx.user.update({
        where: { id: user.id },
        data: { robokassaRecurringId: null },
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
          userId: user.id,
          amount: 0,
          type: "subscription_cancelled",
          description: cancelled
            ? "Автопродление отключено"
            : "Автопродление отключено локально (ответ Robokassa неуспешен)",
        },
      });

      return nextUser;
    });

    return NextResponse.json({
      success: true,
      message: "Автопродление отключено",
      ...serializeSubscriptionState(updated),
    });
  } catch (error) {
    console.error("Cancel recurring subscription error:", error);
    return NextResponse.json({ error: "Не удалось отключить автопродление" }, { status: 500 });
  }
}
