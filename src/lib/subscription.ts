import { prisma } from "@/lib/prisma";
import {
  DEFAULT_SUBSCRIPTION_TYPE,
  getSubscriptionActivationBenefits,
  getSubscriptionPlan,
} from "@/lib/chatEconomy";
import { cancelRobokassaRecurring } from "@/lib/robokassa";
import { applySubscriptionCoinGrant } from "@/lib/verseCoins";

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
  if (!user?.id) return false;
  const activation = await prisma.$transaction(async (tx) => {
    // Same row lock as the payment webhook: balances are read after obtaining it.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    const stored = await tx.user.findUnique({ where: { id: user.id } });
    if (!stored?.pendingSubscriptionType || !stored.pendingSubscriptionEnd) return null;
    const currentEnd = asDate(stored.subscriptionEnd);
    const pendingEnd = asDate(stored.pendingSubscriptionEnd);
    if (!pendingEnd || (currentEnd && currentEnd.getTime() > now.getTime())) return null;
    const plan = getSubscriptionPlan(stored.pendingSubscriptionType);
    const isStart = plan.id === DEFAULT_SUBSCRIPTION_TYPE || plan.monthlyPrice <= 0;
    const benefits = getSubscriptionActivationBenefits(plan, now);
    const coinData = applySubscriptionCoinGrant(stored, benefits.vcGrant, isStart);
    const updated = await tx.user.updateMany({
      where: {
        id: user.id,
        pendingSubscriptionType: stored.pendingSubscriptionType,
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
        ...coinData,
      },
    });

    if (updated.count === 0) {
      return null;
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

    return { previousRecurringId: stored.robokassaRecurringId, plan };
  });

  if (!activation) return false;
  const { previousRecurringId } = activation;
  if (previousRecurringId) {
    const cancelled = await cancelRobokassaRecurring(previousRecurringId);
    console.log(
      `[Subscription] Previous recurring ${cancelled ? "cancelled" : "cancel failed; auto-renew already disabled locally"}: RecurringID=${previousRecurringId}`
    );
  } else {
    console.log(`[Subscription] No previous RecurringID to cancel user=${user.id}`);
  }

  // A new Robokassa parent payment still requires checkout by the user.
  return true;
}

export {
  renewDueSubscriptions,
  renewSubscriptionIfDue,
  renewSubscriptionIfDue as renewSubscriptionForUser,
} from "./subscriptionRenewal";
export type { RenewFailureReason, RenewSubscriptionResult } from "./subscriptionRenewal";
