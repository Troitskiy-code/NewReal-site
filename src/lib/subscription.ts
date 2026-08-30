import { prisma } from "@/lib/prisma";
import {
  DEFAULT_SUBSCRIPTION_TYPE,
  getSubscriptionActivationBenefits,
  getSubscriptionPlan,
} from "@/lib/chatEconomy";
import { cancelRobokassaRecurring } from "@/lib/robokassa";

export type PendingActivationUser = {
  id: string;
  subscriptionType?: string | null;
  subscriptionEnd?: Date | string | null;
  pendingSubscriptionType?: string | null;
  pendingSubscriptionEnd?: Date | string | null;
  robokassaRecurringId?: string | null;
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
  const benefits = getSubscriptionActivationBenefits(plan, now);

  const stored = await prisma.user.findUnique({
    where: { id: user.id },
    select: { robokassaRecurringId: true },
  });
  const previousRecurringId = stored?.robokassaRecurringId ?? user.robokassaRecurringId ?? null;

  console.log(
    `[Subscription] Activating pending plan=${plan.id} user=${user.id} previousRecurringId=${previousRecurringId || "none"}`
  );

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
        robokassaRecurringId: null,
        ...benefits.user,
      },
    });

    if (updated.count === 0) {
      return false;
    }

    await tx.transaction.create({
      data: {
        userId: user.id,
        amount: benefits.transaction.amount,
        type: benefits.transaction.type,
        description: `Активирована отложенная подписка «${plan.name}». ${benefits.transaction.description}`,
      },
    });

    if (!isStart) {
      await tx.transaction.create({
        data: {
          userId: user.id,
          amount: 0,
          type: "recurring_disabled_pending",
          description:
            `Автопродление отключено при смене тарифа на «${plan.name}». Для нового тарифа нужно заново настроить автосписания.`,
        },
      });
    }

    return true;
  });

  if (!activated) {
    console.log(`[Subscription] Pending activation skipped (already applied or race) user=${user.id}`);
    return false;
  }

  console.log(
    `[Subscription] Pending plan activated: user=${user.id}, plan=${plan.id}, robokassaRecurringId=null`
  );

  if (previousRecurringId) {
    const cancelled = await cancelRobokassaRecurring(previousRecurringId);
    console.log(
      `[Subscription] Previous recurring ${cancelled ? "cancelled" : "cancel failed; auto-renew already disabled locally"}: RecurringID=${previousRecurringId}`
    );
  } else {
    console.log(`[Subscription] No previous RecurringID to cancel user=${user.id}`);
  }

  // A new Robokassa parent payment requires checkout, so auto-renewal is not recreated here.
  console.log(
    `[Subscription] New recurring for «${plan.name}» was not created automatically; user must set up auto-renewal via /pricing`
  );

  return true;
}
