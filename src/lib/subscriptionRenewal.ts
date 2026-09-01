import { prisma } from "@/lib/prisma";
import { getSubscriptionActivationBenefits, getSubscriptionPlan } from "@/lib/chatEconomy";
import { buildReceipt, chargeRobokassaRecurring } from "@/lib/robokassa";

export type RenewFailureReason =
  | "user_not_found"
  | "no_recurring_id"
  | "no_subscription_end"
  | "pending_plan_change"
  | "free_plan"
  | "not_due"
  | "already_initiated"
  | "charge_failed";

export type RenewSubscriptionResult = {
  renewed: boolean;
  userId: string;
  invId?: string;
  newEnd?: Date;
  period?: "month" | "year";
  reason?: RenewFailureReason;
  error?: string;
};

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function inferPeriod(subscriptionEnd: Date, lastPaidAt: Date | null): "month" | "year" {
  if (!lastPaidAt) {
    return "month";
  }

  const days = Math.round((subscriptionEnd.getTime() - lastPaidAt.getTime()) / 86_400_000);
  return days > 180 ? "year" : "month";
}

function isDue(subscriptionEnd: Date, now: Date): boolean {
  const windowStart = addDays(now, -2);
  const windowEnd = addDays(now, 1);
  return subscriptionEnd >= windowStart && subscriptionEnd <= windowEnd;
}

async function applySuccessfulRenewal(params: {
  userId: string;
  invId: string;
  planId: string;
  period: "month" | "year";
  now: Date;
}): Promise<Date> {
  const paymentMarker = `Robokassa InvId=${params.invId}`;
  const periodDays = params.period === "year" ? 365 : 30;
  const benefits = getSubscriptionActivationBenefits(getSubscriptionPlan(params.planId), params.now);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.transaction.findFirst({
      where: { userId: params.userId, description: paymentMarker },
      select: { id: true },
    });

    const user = await tx.user.findUnique({
      where: { id: params.userId },
      select: { subscriptionEnd: true },
    });

    if (!user) {
      throw new Error("user_not_found");
    }

    const fallbackEnd = addDays(params.now, periodDays);

    if (existing) {
      return user.subscriptionEnd ?? fallbackEnd;
    }

    const baseDate =
      user.subscriptionEnd && user.subscriptionEnd > params.now ? user.subscriptionEnd : params.now;
    const subscriptionEnd = addDays(baseDate, periodDays);

    await tx.user.update({
      where: { id: params.userId },
      data: {
        subscriptionType: params.planId,
        subscriptionEnd,
        isSubscribed: true,
        ...benefits.user,
      },
    });

    await tx.transaction.create({
      data: {
        userId: params.userId,
        amount: 0,
        type: "subscription_renewal",
        description: paymentMarker,
      },
    });

    await tx.transaction.create({
      data: {
        userId: params.userId,
        amount: benefits.transaction.amount,
        type: benefits.transaction.type,
        description: benefits.transaction.description,
      },
    });

    await tx.transaction.create({
      data: {
        userId: params.userId,
        amount: 0,
        type: "subscription_renewal_initiated",
        description: `Robokassa recurring initiated InvId=${params.invId}`,
      },
    });

    return subscriptionEnd;
  });
}

export async function renewSubscriptionIfDue(
  userId: string,
  options?: { force?: boolean; ignoreInitiated?: boolean; now?: Date }
): Promise<RenewSubscriptionResult> {
  const now = options?.now ?? new Date();
  const force = options?.force === true;
  const ignoreInitiated = options?.ignoreInitiated === true;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      subscriptionType: true,
      subscriptionEnd: true,
      robokassaRecurringId: true,
      pendingSubscriptionType: true,
    },
  });

  if (!user) {
    return { renewed: false, userId, reason: "user_not_found" };
  }

  if (!user.robokassaRecurringId) {
    return { renewed: false, userId, reason: "no_recurring_id" };
  }

  if (!user.subscriptionEnd) {
    return { renewed: false, userId, reason: "no_subscription_end" };
  }

  const pendingPlan = user.pendingSubscriptionType
    ? getSubscriptionPlan(user.pendingSubscriptionType)
    : null;
  if (pendingPlan) {
    console.log(
      `[Robokassa] Renew skipped: user=${user.id} has pending=${pendingPlan.id}, RecurringID=${user.robokassaRecurringId}`
    );
    return { renewed: false, userId, reason: "pending_plan_change" };
  }

  const plan = getSubscriptionPlan(user.subscriptionType);
  if (plan.monthlyPrice <= 0) {
    return { renewed: false, userId, reason: "free_plan" };
  }

  if (!force && !isDue(user.subscriptionEnd, now)) {
    return { renewed: false, userId, reason: "not_due" };
  }

  if (!ignoreInitiated) {
    const recentInit = await prisma.transaction.findFirst({
      where: {
        userId: user.id,
        type: "subscription_renewal_initiated",
        createdAt: { gte: addDays(now, -3) },
      },
      select: { id: true },
    });

    if (recentInit) {
      return { renewed: false, userId, reason: "already_initiated" };
    }
  } else {
    console.log("⚠️ Force mode: ignoring already_initiated");
  }

  const lastPaid = await prisma.transaction.findFirst({
    where: {
      userId: user.id,
      type: { in: ["subscription", "subscription_renewal"] },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  const period = inferPeriod(user.subscriptionEnd, lastPaid?.createdAt ?? null);
  const amount = period === "year" ? plan.yearlyPrice : plan.monthlyPrice;
  const periodLabel = period === "year" ? "год" : "месяц";
  const desc = `Подписка ${plan.name} на 1 ${periodLabel}`;

  console.log(
    `[Subscription] Renew charge: user=${user.id} period=${period} amount=${amount} RecurringID=${user.robokassaRecurringId}`
  );

  try {
    const { invId } = await chargeRobokassaRecurring({
      previousInvoiceId: user.robokassaRecurringId,
      sum: amount,
      desc,
      extraShp: {
        Shp_userId: user.id,
        Shp_subscription: "true",
        Shp_plan: plan.id,
        Shp_period: period,
        Shp_applyMode: "immediate",
      },
      receipt: buildReceipt([{ name: desc, price: amount, quantity: 1 }]),
    });

    const newEnd = await applySuccessfulRenewal({
      userId: user.id,
      invId,
      planId: plan.id,
      period,
      now,
    });

    console.log(
      `[Subscription] Renewed: user=${user.id} InvId=${invId} newEnd=${newEnd.toISOString()}`
    );

    return { renewed: true, userId: user.id, invId, newEnd, period };
  } catch (error) {
    const message = error instanceof Error ? error.message : "charge_failed";
    console.error(`[Subscription] Renew failed: user=${user.id}`, error);
    return { renewed: false, userId, reason: "charge_failed", error: message };
  }
}

export async function renewDueSubscriptions(now = new Date()) {
  const windowStart = addDays(now, -2);
  const windowEnd = addDays(now, 1);

  console.log("[Cron] Looking for users with expired subscriptions...");
  console.log("[Cron] Current time (UTC):", now.toISOString());
  console.log("[Cron] Due window (UTC):", {
    from: windowStart.toISOString(),
    to: windowEnd.toISOString(),
    requires: "robokassaRecurringId != null AND isSubscribed = true",
  });

  const users = await prisma.user.findMany({
    where: {
      robokassaRecurringId: { not: null },
      subscriptionEnd: { gte: windowStart, lte: windowEnd },
      isSubscribed: true,
    },
    select: {
      id: true,
      subscriptionEnd: true,
      robokassaRecurringId: true,
      subscriptionType: true,
    },
  });

  console.log("[Cron] Found users:", users.length);
  for (const user of users) {
    console.log("[Cron] Candidate:", {
      id: user.id,
      subscriptionEnd: user.subscriptionEnd?.toISOString() ?? null,
      robokassaRecurringId: user.robokassaRecurringId,
      subscriptionType: user.subscriptionType,
    });
  }

  const results: Array<{ userId: string; invId?: string; skipped?: string; error?: string }> = [];

  for (const user of users) {
    console.log(`[Cron] Renewing user=${user.id}...`);
    const result = await renewSubscriptionIfDue(user.id, { now });
    if (result.renewed) {
      console.log(`[Cron] Renewed user=${result.userId} invId=${result.invId} newEnd=${result.newEnd?.toISOString() ?? "none"}`);
      results.push({ userId: result.userId, invId: result.invId });
      continue;
    }

    if (result.reason === "charge_failed") {
      console.error(`[Cron] Charge failed user=${result.userId} reason=${result.reason} error=${result.error ?? "none"}`);
      results.push({ userId: result.userId, error: result.error ?? result.reason });
      continue;
    }

    console.log(`[Cron] Skipped user=${result.userId} reason=${result.reason ?? "unknown"}`);
    results.push({ userId: result.userId, skipped: result.reason ?? "unknown" });
  }

  return { checked: users.length, results };
}
