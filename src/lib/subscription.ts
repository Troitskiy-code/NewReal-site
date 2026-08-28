import { prisma } from "@/lib/prisma";
import { DEFAULT_SUBSCRIPTION_TYPE, getSubscriptionPlan } from "@/lib/chatEconomy";

export type PendingActivationUser = {
  id: string;
  subscriptionType?: string | null;
  subscriptionEnd?: Date | string | null;
  pendingSubscriptionType?: string | null;
  pendingSubscriptionEnd?: Date | string | null;
};

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function activatePendingSubscriptionIfNeeded(
  user: PendingActivationUser | null | undefined,
  now = new Date()
): Promise<boolean> {
  if (!user?.id || !user.pendingSubscriptionType || !user.pendingSubscriptionEnd) {
    return false;
  }

  const currentEnd = asDate(user.subscriptionEnd);
  const pendingEnd = asDate(user.pendingSubscriptionEnd);
  if (!pendingEnd) {
    return false;
  }

  const currentExpired = !currentEnd || currentEnd.getTime() <= now.getTime();
  if (!currentExpired) {
    return false;
  }

  const plan = getSubscriptionPlan(user.pendingSubscriptionType);
  const isStart = plan.id === DEFAULT_SUBSCRIPTION_TYPE || plan.monthlyPrice <= 0;

  const activated = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: {
        id: user.id,
        pendingSubscriptionType: user.pendingSubscriptionType,
        OR: [{ subscriptionEnd: null }, { subscriptionEnd: { lte: now } }],
      },
      data: {
        subscriptionType: isStart ? DEFAULT_SUBSCRIPTION_TYPE : plan.id,
        subscriptionEnd: pendingEnd,
        isSubscribed: !isStart,
        pendingSubscriptionType: null,
        pendingSubscriptionEnd: null,
      },
    });

    if (updated.count === 0) {
      return false;
    }

    await tx.transaction.create({
      data: {
        userId: user.id,
        amount: 0,
        type: "subscription_activated_pending",
        description: `Активирована отложенная подписка «${plan.name}»`,
      },
    });

    return true;
  });

  return activated;
}
