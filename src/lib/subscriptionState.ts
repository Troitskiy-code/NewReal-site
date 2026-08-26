import { prisma } from "@/lib/prisma";
import {
  DEFAULT_SUBSCRIPTION_TYPE,
  getSubscriptionLabel,
  getSubscriptionPlan,
} from "@/lib/chatEconomy";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";

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
  subscriptionType: true,
  subscriptionEnd: true,
  pendingSubscriptionType: true,
  pendingSubscriptionEnd: true,
  isSubscribed: true,
} as const;

export type SubscriptionState = {
  subscriptionType: string | null;
  subscriptionEnd: Date | null;
  pendingSubscriptionType: string | null;
  pendingSubscriptionEnd: Date | null;
  isSubscribed: boolean;
};

export function serializeSubscriptionState(user: SubscriptionState, now = new Date()) {
  const subscriptionActive = isSubscriptionActive(user);
  const pendingPlan = user.pendingSubscriptionType
    ? getSubscriptionPlan(user.pendingSubscriptionType)
    : null;

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

  if (!user.pendingSubscriptionType || !user.pendingSubscriptionEnd || user.pendingSubscriptionEnd > now) {
    return user;
  }

  const plan = getSubscriptionPlan(user.pendingSubscriptionType);
  const isStart = plan.id === DEFAULT_SUBSCRIPTION_TYPE || plan.monthlyPrice <= 0;

  return prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionType: isStart ? DEFAULT_SUBSCRIPTION_TYPE : plan.id,
      subscriptionEnd: isStart ? null : addSubscriptionDays(now, 30),
      isSubscribed: !isStart,
      pendingSubscriptionType: null,
      pendingSubscriptionEnd: null,
    },
    select: SUBSCRIPTION_SELECT,
  });
}
