import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSubscriptionActivationBenefits, getSubscriptionPlan } from "@/lib/chatEconomy";
import { buildReceipt, chargeRobokassaRecurring, fetchRobokassaInvoiceState } from "@/lib/robokassa";
import { applySubscriptionCoinGrant, getExpiringCoins } from "@/lib/verseCoins";
import { paymentEventCreateData, PAYMENT_PROVIDER } from "@/lib/paymentEvent";
import { errorLog, infoLog } from "@/lib/logger";

export type RenewFailureReason =
  | "user_not_found"
  | "no_recurring_id"
  | "no_subscription_end"
  | "pending_plan_change"
  | "free_plan"
  | "not_due"
  | "already_initiated"
  | "awaiting_confirmation"
  | "charge_failed";

export type RenewSubscriptionResult = {
  renewed: boolean;
  /** A recurring charge was sent; the period is granted only once Robokassa confirms it. */
  initiated?: boolean;
  userId: string;
  invId?: string;
  newEnd?: Date;
  period?: "month" | "year";
  reason?: RenewFailureReason;
  error?: string;
};

type Period = "month" | "year";
type PendingCharge = { invId: string; planId: string; period: Period; amountRub: number; createdAt: Date };

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

const INITIATED_TYPE = "subscription_renewal_initiated";
const DECLINED_TYPE = "subscription_renewal_declined";
const INITIATED_TTL_MS = 24 * 60 * 60 * 1000;
// ResultURL normally arrives within seconds; only then ask Robokassa directly.
const CONFIRMATION_GRACE_MS = 10 * 60 * 1000;
// An operation still "initialised" (State 5) a day later was never paid.
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const RECONCILE_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;
const PAID_STATE = 100;
const DECLINED_STATES = new Set([10, 60]);

const grantMarker = (invId: string) => `Robokassa InvId=${invId}`;
const initiatedMarker = (charge: Omit<PendingCharge, "createdAt">) =>
  `Robokassa recurring initiated InvId=${charge.invId} plan=${charge.planId} period=${charge.period} amount=${charge.amountRub}`;
const INITIATED_RE = /^Robokassa recurring initiated InvId=(\d{1,20}) plan=([a-z]+) period=(month|year) amount=(\d+(?:\.\d+)?)$/;

function inferPeriod(subscriptionEnd: Date, lastPaidAt: Date | null): Period {
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

function formatSubscriptionEnd(date: Date): string {
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * The only place a paid renewal period is granted: ResultURL and the OpStateExt reconciliation both
 * call it, so a confirmed invoice extends the subscription exactly once whichever arrives first.
 * Before 2026-10-21 the cron granted the period when it merely sent the charge, which also gave a
 * period for charges that later failed, and the webhook granted it again (+60 days).
 */
export async function grantConfirmedRenewal(tx: Prisma.TransactionClient, params: {
  userId: string; invId: string; planId: string; period: Period; amountRub: number | null;
  /** Series id to store; omit to keep the user's current RecurringID. */
  recurringId?: string | null; now: Date;
  /** When the charge was sent. A late confirmation extends from then, so a lapse while waiting costs no paid days. */
  chargedAt?: Date;
}): Promise<{ granted: boolean; subscriptionEnd: Date | null }> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${params.userId} FOR UPDATE`;
  const confirmed = await tx.paymentEvent.findUnique({
    where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId: params.invId } }, select: { userId: true } });
  if (confirmed) return { granted: false, subscriptionEnd: null };
  const plan = getSubscriptionPlan(params.planId);
  const event = paymentEventCreateData(params.invId, params.userId, "subscription_renewal", {
    planId: plan.monthlyPrice > 0 ? plan.id : null, amountRub: params.amountRub });
  // A charge sent by the pre-2026-10-21 cron was already granted then; only record its confirmation.
  const legacyGrant = await tx.transaction.findFirst({
    where: { userId: params.userId, description: grantMarker(params.invId), type: "subscription_renewal" }, select: { id: true } });
  if (legacyGrant) {
    await tx.paymentEvent.create({ data: event });
    return { granted: false, subscriptionEnd: null };
  }
  const user = await tx.user.findUnique({ where: { id: params.userId },
    select: { subscriptionEnd: true, verseCoins: true, permanentCoins: true } });
  if (!user) throw new Error("user_not_found");
  const reference = params.chargedAt ?? params.now;
  const baseDate = user.subscriptionEnd && user.subscriptionEnd > reference ? user.subscriptionEnd : reference;
  const subscriptionEnd = addDays(baseDate, params.period === "year" ? 365 : 30);
  const benefits = getSubscriptionActivationBenefits(plan, params.now);
  const coinData = applySubscriptionCoinGrant(
    { id: params.userId, verseCoins: user.verseCoins, permanentCoins: user.permanentCoins }, benefits.vcGrant);
  await tx.paymentEvent.create({ data: event });
  await tx.user.update({ where: { id: params.userId }, data: {
    subscriptionType: plan.id, subscriptionEnd, isSubscribed: true,
    ...(params.recurringId ? { robokassaRecurringId: params.recurringId } : {}),
    ...benefits.user, ...coinData,
  } });
  await tx.transaction.create({ data: { userId: params.userId, amount: 0, type: "subscription_renewal", description: grantMarker(params.invId) } });
  await tx.transaction.create({ data: { userId: params.userId, amount: benefits.transaction.amount,
    type: benefits.transaction.type, description: benefits.transaction.description } });
  await tx.notification.create({ data: { userId: params.userId, type: "purchase_subscription", title: "Подписка активирована",
    message: `Подписка «${plan.name}» активна до ${formatSubscriptionEnd(subscriptionEnd)}.`, link: "/subscription" } });
  return { granted: true, subscriptionEnd };
}

/** The latest charge the cron sent for this user that neither ResultURL nor reconciliation has settled. */
async function pendingCharge(userId: string, since: Date): Promise<PendingCharge | null> {
  const initiated = await prisma.transaction.findFirst({
    where: { userId, type: INITIATED_TYPE, description: { startsWith: "Robokassa recurring initiated InvId=" }, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" }, select: { description: true, createdAt: true } });
  const match = initiated?.description ? INITIATED_RE.exec(initiated.description) : null;
  // Markers without plan/period come from the old cron, which granted at send time: nothing pending.
  if (!initiated || !match) return null;
  const invId = match[1];
  const settled = await Promise.all([
    prisma.paymentEvent.findUnique({ where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId: invId } }, select: { id: true } }),
    prisma.transaction.findFirst({ where: { userId, description: grantMarker(invId), type: "subscription_renewal" }, select: { id: true } }),
    prisma.transaction.findFirst({ where: { userId, type: DECLINED_TYPE, description: { startsWith: `Robokassa recurring declined InvId=${invId} ` } }, select: { id: true } }),
  ]);
  if (settled.some(Boolean)) return null;
  return { invId, planId: match[2], period: match[3] as Period, amountRub: Number(match[4]), createdAt: initiated.createdAt };
}

/** Ask Robokassa about a charge whose ResultURL did not arrive. Never sends a new charge. */
async function settlePendingCharge(userId: string, charge: PendingCharge, now: Date): Promise<"granted" | "declined" | "pending"> {
  const age = now.getTime() - charge.createdAt.getTime();
  if (age < CONFIRMATION_GRACE_MS) return "pending";
  let state;
  try {
    state = await fetchRobokassaInvoiceState(charge.invId);
  } catch (error) {
    errorLog("Subscription", "Renewal state check failed", { userId, invId: charge.invId }, error);
    return "pending";
  }
  if (state.result === 0 && state.state === PAID_STATE) {
    const outcome = await prisma.$transaction(tx => grantConfirmedRenewal(tx, {
      userId, invId: charge.invId, planId: charge.planId, period: charge.period, amountRub: charge.amountRub, now, chargedAt: charge.createdAt }));
    infoLog("Subscription", "Renewal confirmed by state check", { userId, invId: charge.invId, granted: outcome.granted });
    return "granted";
  }
  const declined = state.result === 0 && state.state !== null && DECLINED_STATES.has(state.state)
    || state.result === 0 && state.state === 5 && age > ABANDONED_AFTER_MS
    || state.result === 3 && age > 60 * 60 * 1000;
  if (!declined) {
    if (age > ABANDONED_AFTER_MS) errorLog("Subscription", "Renewal still unsettled", { userId, invId: charge.invId, result: state.result, state: state.state });
    return "pending";
  }
  await prisma.transaction.create({ data: { userId, amount: 0, type: DECLINED_TYPE,
    description: `Robokassa recurring declined InvId=${charge.invId} result=${state.result} state=${state.state ?? "none"}` } });
  infoLog("Subscription", "Renewal charge declined", { userId, invId: charge.invId, result: state.result, state: state.state });
  return "declined";
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
      email: true,
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

  // Never send a second charge while an earlier one may still succeed: that would take the money twice.
  // Even force mode respects this; only a definite decline from Robokassa frees the way.
  const pending = await pendingCharge(user.id, new Date(now.getTime() - RECONCILE_WINDOW_MS));
  if (pending) {
    const settled = await settlePendingCharge(user.id, pending, now);
    if (settled === "granted") {
      const after = await prisma.user.findUnique({ where: { id: user.id }, select: { subscriptionEnd: true } });
      return { renewed: true, userId, invId: pending.invId, newEnd: after?.subscriptionEnd ?? undefined, period: pending.period };
    }
    if (settled === "pending") {
      return { renewed: false, userId, invId: pending.invId, reason: "awaiting_confirmation" };
    }
  }

  if (!ignoreInitiated) {
    const recentInit = await prisma.transaction.findFirst({
      where: {
        userId: user.id,
        type: INITIATED_TYPE,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    });

    if (recentInit) {
      const initiatedAt = recentInit.createdAt;
      const ageMs = now.getTime() - initiatedAt.getTime();
      if (ageMs < INITIATED_TTL_MS) {
        return { renewed: false, userId, reason: "already_initiated" };
      }

      console.log(
        `[Cron] Resetting stale initiated flag for user=${user.id} (initiated at ${initiatedAt.toISOString()}).`
      );
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

  let invId: string;
  try {
    ({ invId } = await chargeRobokassaRecurring({
      previousInvoiceId: user.robokassaRecurringId,
      sum: amount,
      desc,
      extraShp: {
        Shp_userId: user.id,
        Shp_subscription: "true",
        Shp_plan: plan.id,
        Shp_period: period,
        Shp_applyMode: "immediate",
        // Lets ResultURL route this child charge to the renewal grant even if the period lapsed meanwhile.
        Shp_renewal: "true",
      },
      receipt: buildReceipt([{ name: desc, price: amount, quantity: 1 }]),
      email: user.email,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "charge_failed";
    errorLog("Subscription", "Renew failed", { userId: user.id }, error);
    try {
      await prisma.transaction.create({
        data: {
          userId: user.id,
          amount: 0,
          type: INITIATED_TYPE,
          description: `Robokassa recurring failed: ${message}`,
        },
      });
    } catch (writeError) {
      errorLog("Subscription", "Failed to store initiatedAt", { userId: user.id }, writeError);
    }
    return { renewed: false, userId, reason: "charge_failed", error: message };
  }

  // "OK" only means Robokassa created the operation. The period is granted on ResultURL or by the
  // state check of a later cron run, never here.
  await prisma.transaction.create({ data: { userId: user.id, amount: 0, type: INITIATED_TYPE,
    description: initiatedMarker({ invId, planId: plan.id, period, amountRub: amount }) } });
  console.log(`[Subscription] Renewal charge sent: user=${user.id} InvId=${invId}; awaiting confirmation`);
  return { renewed: false, initiated: true, userId: user.id, invId, period };
}

/** Settles charges whose ResultURL was lost, including users whose period has already lapsed. */
async function reconcilePendingRenewals(now: Date) {
  const since = new Date(now.getTime() - RECONCILE_WINDOW_MS);
  const rows = await prisma.transaction.findMany({
    where: { type: INITIATED_TYPE, description: { startsWith: "Robokassa recurring initiated InvId=" }, createdAt: { gte: since } },
    distinct: ["userId"], select: { userId: true } });
  const outcomes: Array<{ userId: string; invId: string; outcome: "granted" | "declined" | "pending" }> = [];
  for (const { userId } of rows) {
    const charge = await pendingCharge(userId, since);
    if (!charge) continue;
    outcomes.push({ userId, invId: charge.invId, outcome: await settlePendingCharge(userId, charge, now) });
  }
  return outcomes;
}

export async function renewDueSubscriptions(now = new Date()) {
  const windowStart = addDays(now, -2);
  const windowEnd = addDays(now, 1);

  const reconciled = await reconcilePendingRenewals(now);
  if (reconciled.length) console.log("[Cron] Reconciled pending renewal charges:", reconciled);

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

  const results: Array<{ userId: string; invId?: string; initiated?: boolean; skipped?: string; error?: string }> = [];

  for (const user of users) {
    console.log(`[Cron] Renewing user=${user.id}...`);
    const result = await renewSubscriptionIfDue(user.id, { now });
    if (result.renewed) {
      console.log(`[Cron] Renewed user=${result.userId} invId=${result.invId} newEnd=${result.newEnd?.toISOString() ?? "none"}`);
      results.push({ userId: result.userId, invId: result.invId });
      continue;
    }

    if (result.initiated) {
      console.log(`[Cron] Charge sent user=${result.userId} invId=${result.invId}; awaiting Robokassa confirmation`);
      results.push({ userId: result.userId, invId: result.invId, initiated: true });
      continue;
    }

    if (result.reason === "charge_failed") {
      errorLog("Cron:RenewSubscriptions", "Charge failed", { userId: result.userId, reason: result.reason });
      results.push({ userId: result.userId, error: result.error ?? result.reason });
      continue;
    }

    console.log(`[Cron] Skipped user=${result.userId} reason=${result.reason ?? "unknown"}`);
    results.push({ userId: result.userId, skipped: result.reason ?? "unknown" });
  }

  const expiredCoins = await expireLapsedSubscriptionCoins(now);
  return { checked: users.length, reconciled, results, expiredCoins };
}

async function expireLapsedSubscriptionCoins(now: Date) {
  const lapsedBefore = addDays(now, -2);
  const users = await prisma.user.findMany({
    where: { subscriptionEnd: { lt: lapsedBefore } },
    select: { id: true, verseCoins: true, permanentCoins: true },
  });

  let expired = 0;
  for (const user of users) {
    if (getExpiringCoins(user) <= 0) {
      continue;
    }
    const coinData = applySubscriptionCoinGrant(user, 0, true);
    await prisma.user.update({
      where: { id: user.id },
      data: coinData,
    });
    expired += 1;
  }

  if (expired > 0) {
    console.log(`[Coins] Expired leftover subscription VC for ${expired} users`);
  }

  return expired;
}
