import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSubscriptionActivationBenefits, getSubscriptionPlan } from "@/lib/chatEconomy";
import { PAYMENT_PROVIDER } from "@/lib/paymentEvent";
import { applySubscriptionCoinGrant } from "@/lib/verseCoins";

export type PendingActivationUser = {
  id: string;
  subscriptionType?: string | null;
  subscriptionEnd?: Date | string | null;
  pendingSubscriptionType?: string | null;
  pendingSubscriptionEnd?: Date | string | null;
  robokassaRecurringId?: string | null;
};

export function pendingPaymentMarker(invoiceId: string, end: Date) {
  return "Robokassa InvId=" + invoiceId + " PendingUntil=" + end.toISOString();
}

export async function confirmedPendingInvoice(tx: Prisma.TransactionClient, user: {
  id: string; subscriptionEnd: Date | null; pendingSubscriptionEnd: Date | null;
  pendingSubscriptionType: string | null; robokassaRecurringId: string | null;
}) {
  if (!user.pendingSubscriptionEnd || !user.pendingSubscriptionType || !user.subscriptionEnd
      || user.pendingSubscriptionEnd <= user.subscriptionEnd) return null;

  const marker = await tx.transaction.findFirst({ where: { userId: user.id, type: "subscription_pending",
    description: { startsWith: "Robokassa InvId=", endsWith: " PendingUntil=" + user.pendingSubscriptionEnd.toISOString() },
  }, orderBy: { createdAt: "desc" }, select: { description: true } });
  const invoiceId = /^Robokassa InvId=(\d+) PendingUntil=/.exec(marker?.description ?? "")?.[1];
  // Older paid deferrals recorded the new parent as the recurring ID and a plain invoice marker.
  const candidate = invoiceId ?? user.robokassaRecurringId;
  if (!candidate) return null;
  const payment = await tx.paymentEvent.findUnique({ where: {
    provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId: candidate },
  } });
  if (payment?.userId !== user.id || payment.kind !== "subscription_pending" || !payment.amountRub
      || getSubscriptionPlan(payment.planId).id !== getSubscriptionPlan(user.pendingSubscriptionType).id) return null;

  if (!invoiceId) {
    const legacy = await tx.transaction.findFirst({ where: { userId: user.id, type: "subscription_pending",
      description: "Robokassa InvId=" + candidate }, select: { id: true } });
    if (!legacy) return null;
  }
  return candidate;
}

export async function activatePendingSubscriptionIfNeeded(
  user: PendingActivationUser | null | undefined,
  now = new Date(),
): Promise<boolean> {
  if (!user?.id || !user.pendingSubscriptionType) return false;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    const stored = await tx.user.findUnique({ where: { id: user.id } });
    if (!stored?.pendingSubscriptionType) return false;

    const invoice = await confirmedPendingInvoice(tx, stored);
    const plan = getSubscriptionPlan(stored.pendingSubscriptionType);
    const end = stored.pendingSubscriptionEnd;
    const clearPending = { pendingSubscriptionType: null, pendingSubscriptionEnd: null };
    if (!invoice || !end || plan.monthlyPrice <= 0 || end <= now) {
      await tx.user.update({ where: { id: stored.id }, data: {
        ...clearPending,
        ...(invoice && stored.robokassaRecurringId === invoice ? { robokassaRecurringId: null } : {}),
      } });
      return true;
    }
    if (stored.subscriptionEnd && stored.subscriptionEnd > now) return false;

    const benefits = getSubscriptionActivationBenefits(plan, now);
    await tx.user.update({ where: { id: stored.id }, data: {
      ...clearPending,
      subscriptionType: plan.id, subscriptionEnd: end, isSubscribed: true,
      robokassaRecurringId: stored.robokassaRecurringId === invoice ? invoice : null,
      ...benefits.user, ...applySubscriptionCoinGrant(stored, benefits.vcGrant),
    } });
    await tx.transaction.create({ data: { userId: stored.id, ...benefits.transaction,
      description: "Активирована отложенная подписка «" + plan.name + "». " + benefits.transaction.description,
    } });
    return true;
  });
}

export {
  renewDueSubscriptions,
  renewSubscriptionIfDue,
  renewSubscriptionIfDue as renewSubscriptionForUser,
} from "./subscriptionRenewal";
export type { RenewFailureReason, RenewSubscriptionResult } from "./subscriptionRenewal";
