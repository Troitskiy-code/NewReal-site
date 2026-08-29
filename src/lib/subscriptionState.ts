import { prisma } from "@/lib/prisma";
import {
  DEFAULT_SUBSCRIPTION_TYPE,
  getSubscriptionLabel,
  getSubscriptionPlan,
} from "@/lib/chatEconomy";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";
import { activatePendingSubscriptionIfNeeded } from "@/lib/subscription";

export function addSubscriptionDays(from: Date, days: number): Date {
  const result = new Date(from);
  result.setDate(result.getDate() + days);
  return result;
}

export function getDaysRemaining(end: Date | string | null | undefined, now = new Date()): number {
  if (!end) return 0;
  const date = end instanceof Date ? end : new Date(end);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 86_400_000));
}

export function subscriptionPeriodDays(period: "month" | "year"): number {
  return period === "year" ? 365 : 30;
}

const SUBSCRIPTION_SELECT = {
  id: true,
  subscriptionType: true,
  subscriptionEnd: true,
  pendingSubscriptionType: true,
  pendingSubscriptionEnd: true,
  isSubscribed: true,
  robokassaRecurringId: true,
} as const;

export type SubscriptionState = {
  subscriptionType: string | null;
  subscriptionEnd: Date | null;
  pendingSubscriptionType: string | null;
  pendingSubscriptionEnd: Date | null;
  isSubscribed: boolean;
  robokassaRecurringId?: string | null;
};

export function serializeSubscriptionState(user: SubscriptionState, now = new Date()) {
  const subscriptionActive = isSubscriptionActive(user);
  const pendingPlan = user.pendingSubscriptionType
    ? getSubscriptionPlan(user.pendingSubscriptionType)
    : null;
  const currentPlan = getSubscriptionPlan(user.subscriptionType);
  const recurringEnabled = Boolean(user.robokassaRecurringId);
  const recurringSetupRequired =
    subscriptionActive && currentPlan.monthlyPrice > 0 && !recurringEnabled;

  return {
    subscriptionType: user.subscriptionType,
    subscriptionEnd: user.subscriptionEnd,
    subscriptionActive,
    subscriptionLabel: subscriptionActive
      ? getSubscriptionLabel(user.subscriptionType)
      : getSubscriptionPlan(user.subscriptionType ?? DEFAULT_SUBSCRIPTION_TYPE).name,
    daysRemaining: getDaysRemaining(user.subscriptionEnd, now),
    pendingSubscriptionType: user.pendingSubscriptionType,
    pendingSubscriptionEnd: user.pendingSubscriptionEnd,
    pendingSubscriptionLabel: pendingPlan?.name ?? null,
    recurringEnabled,
    recurringSetupRequired,
  };
}

export async function applyPendingSubscriptionIfDue(
  userId: string,
  now = new Date()
): Promise<SubscriptionState | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: SUBSCRIPTION_SELECT,
  });

  if (!user) return null;

  const activated = await activatePendingSubscriptionIfNeeded(user, now);
  if (!activated) {
    return user;
  }

  return prisma.user.findUnique({
    where: { id: userId },
    select: SUBSCRIPTION_SELECT,
  });
}
