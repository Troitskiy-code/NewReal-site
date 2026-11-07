import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSubscriptionActivationBenefits, getSubscriptionPlan, SUBSCRIPTION_PLANS } from "@/lib/chatEconomy";
import { buildReceipt, chargeRobokassaRecurring, createRobokassaInvoiceId, fetchRobokassaInvoiceState, ROBOKASSA_TEST_MODE } from "@/lib/robokassa";
import { applySubscriptionCoinGrant } from "@/lib/verseCoins";
import { paymentEventCreateData, parseConfirmedAmountRub, PAYMENT_PROVIDER } from "@/lib/paymentEvent";
import { errorLog } from "@/lib/logger";

export type RenewFailureReason =
  | "user_not_found"
  | "no_recurring_id"
  | "no_confirmed_agreement"
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
const RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
const CONFIRMATION_GRACE_MS = 10 * 60 * 1000;
const RECONCILE_WINDOW_MS = 4 * RETRY_DELAY_MS;
const PAID_STATE = 100;
const DECLINED_STATES = new Set([10, 60]);
const INITIATED_RE = /^Robokassa recurring initiated InvId=(\d{1,20}) plan=([a-z]+) period=(month|year) amount=(\d+(?:\.\d+)?)$/;
const grantMarker = (invId: string) => "Robokassa InvId=" + invId;
const initiatedPrefix = "Robokassa recurring initiated InvId=";

function isDue(subscriptionEnd: Date, now: Date): boolean {
  return subscriptionEnd >= addDays(now, -2) && subscriptionEnd <= addDays(now, 1);
}

function parsePendingCharge(row: { description: string | null; createdAt: Date } | null): PendingCharge | null {
  const match = row?.description && INITIATED_RE.exec(row.description);
  if (!row || !match) return null;
  const amountRub = parseConfirmedAmountRub(match[4]);
  if (amountRub === null) return null;
  return { invId: match[1], planId: match[2], period: match[3] as Period, amountRub, createdAt: row.createdAt };
}

export async function findRenewalCharge(tx: Prisma.TransactionClient, userId: string, invoiceId: string) {
  const row = await tx.transaction.findFirst({
    where: { userId, type: INITIATED_TYPE, description: { startsWith: initiatedPrefix + invoiceId + " " } },
    select: { description: true, createdAt: true },
  });
  return parsePendingCharge(row);
}

/** The caller has verified the provider response and holds the account lock. */
export async function grantConfirmedRenewal(tx: Prisma.TransactionClient, userId: string, charge: PendingCharge, now: Date) {
  const existing = await tx.paymentEvent.findUnique({
    where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId: charge.invId } },
    select: { userId: true },
  });
  if (existing) {
    if (existing.userId !== userId) throw new Error("Renewal invoice owner conflict");
    return;
  }

  const plan = SUBSCRIPTION_PLANS.find(item => item.id === charge.planId && item.monthlyPrice > 0);
  const user = await tx.user.findUnique({ where: { id: userId },
    select: { subscriptionEnd: true, subscriptionType: true, pendingSubscriptionType: true,
      verseCoins: true, permanentCoins: true } });
  if (!plan || !user) throw new Error("Unknown renewal plan or account");

  const event = paymentEventCreateData(charge.invId, userId, "subscription_renewal", {
    planId: plan.id, amountRub: charge.amountRub,
  });
  const legacyGrant = await tx.transaction.findFirst({
    where: { userId, description: grantMarker(charge.invId), type: "subscription_renewal" }, select: { id: true },
  });
  if (legacyGrant) {
    await tx.paymentEvent.create({ data: event });
    return;
  }

  // A delayed confirmation must never replace another paid tariff.
  if (user.pendingSubscriptionType || (user.subscriptionEnd && user.subscriptionEnd > now
      && getSubscriptionPlan(user.subscriptionType).id !== plan.id)) {
    throw new Error("Paid renewal conflicts with a plan change");
  }

  const baseDate = user.subscriptionEnd && user.subscriptionEnd > charge.createdAt ? user.subscriptionEnd : charge.createdAt;
  const subscriptionEnd = addDays(baseDate, charge.period === "year" ? 365 : 30);
  const benefits = getSubscriptionActivationBenefits(plan, now);
  const coinData = applySubscriptionCoinGrant({ id: userId, ...user }, benefits.vcGrant);
  await tx.paymentEvent.create({ data: event });
  await tx.user.update({ where: { id: userId }, data: {
    subscriptionType: plan.id, subscriptionEnd, isSubscribed: true, ...benefits.user, ...coinData,
  } });
  await tx.transaction.create({ data: { userId, amount: 0, type: "subscription_renewal", description: grantMarker(charge.invId) } });
  await tx.transaction.create({ data: { userId, ...benefits.transaction } });
  const date = subscriptionEnd.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  await tx.notification.create({ data: { userId, type: "purchase_subscription", title: "Подписка активирована",
    message: "Подписка «" + plan.name + "» активна до " + date + ".", link: "/subscription" } });
}

async function pendingCharge(userId: string, client: Prisma.TransactionClient = prisma): Promise<PendingCharge | null> {
  const latest = await client.transaction.findFirst({
    where: { userId, type: INITIATED_TYPE, description: { startsWith: initiatedPrefix } },
    orderBy: { createdAt: "desc" }, select: { description: true, createdAt: true },
  });
  const charge = parsePendingCharge(latest);
  if (!charge) return null;
  const settled = await Promise.all([
    client.paymentEvent.findUnique({ where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId: charge.invId } },
      select: { id: true } }),
    client.transaction.findFirst({ where: { userId, description: grantMarker(charge.invId), type: "subscription_renewal" },
      select: { id: true } }),
    client.transaction.findFirst({ where: { userId, type: DECLINED_TYPE,
      description: { startsWith: "Robokassa recurring declined InvId=" + charge.invId + " " } }, select: { id: true } }),
  ]);
  return settled.some(Boolean) ? null : charge;
}

async function settlePendingCharge(userId: string, charge: PendingCharge, now: Date): Promise<"granted" | "declined" | "pending"> {
  const age = now.getTime() - charge.createdAt.getTime();
  if (age < CONFIRMATION_GRACE_MS) return "pending";

  try {
    const state = await fetchRobokassaInvoiceState(charge.invId);
    if (state.result === 0 && state.state === PAID_STATE) {
      if (parseConfirmedAmountRub(state.outSum) !== charge.amountRub || !/^(?:RUB|RUR)$/i.test(state.currency ?? "")) {
        errorLog("Subscription", "Confirmed renewal has an unexpected amount or currency", { userId, invId: charge.invId });
        return "pending";
      }
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        await grantConfirmedRenewal(tx, userId, charge, now);
      });
      return "granted";
    }

    const declined = state.result === 0 && state.state !== null && DECLINED_STATES.has(state.state);
    // A missing operation can be retried only after the original send window has safely passed.
    if (!declined && !(state.result === 3 && age >= RETRY_DELAY_MS)) return "pending";

    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const latest = await pendingCharge(userId, tx);
      if (latest?.invId !== charge.invId) return;
      await tx.transaction.create({ data: { userId, amount: 0, type: DECLINED_TYPE,
        description: "Robokassa recurring declined InvId=" + charge.invId + " result=" + state.result + " state=" + state.state } });
    });
    return "declined";
  } catch (error) {
    errorLog("Subscription", "Renewal state check or settlement failed", { userId, invId: charge.invId }, error);
    return "pending";
  }
}

async function reserveRenewal(userId: string, now: Date, force: boolean) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: {
      email: true, subscriptionType: true, subscriptionEnd: true, isSubscribed: true,
      pendingSubscriptionType: true, robokassaRecurringId: true,
    } });
    if (!user) return { reason: "user_not_found" } as const;
    const parentId = user.robokassaRecurringId;
    if (!parentId) return { reason: "no_recurring_id" } as const;
    if (!user.subscriptionEnd) return { reason: "no_subscription_end" } as const;
    if (user.pendingSubscriptionType) return { reason: "pending_plan_change" } as const;
    const plan = getSubscriptionPlan(user.subscriptionType);
    if (!user.isSubscribed || plan.monthlyPrice <= 0) return { reason: "free_plan" } as const;
    if (!force && !isDue(user.subscriptionEnd, now)) return { reason: "not_due" } as const;
    if (await pendingCharge(userId, tx)) return { reason: "awaiting_confirmation" } as const;

    const lastAttempt = await tx.transaction.findFirst({ where: { userId, type: INITIATED_TYPE },
      orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    if (lastAttempt && now.getTime() - lastAttempt.createdAt.getTime() < RETRY_DELAY_MS) {
      return { reason: "already_initiated" } as const;
    }

    const key = { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId: parentId } };
    const parent = await tx.paymentEvent.findUnique({ where: key });
    const order = await tx.paymentOrder.findUnique({ where: key });
    let approvedAmount = parent?.amountRub ?? null;
    if (!parent && !order) {
      // Payments from before PaymentOrder/PaymentEvent had a signed ResultURL ledger entry.
      // Preserve them only if a later confirmed renewal also identifies the same account and tariff.
      const initial = await tx.transaction.findFirst({
        where: { userId, type: "subscription", description: grantMarker(parentId) },
        select: { createdAt: true },
      });
      const originalActivation = initial && await tx.transaction.findFirst({
        where: { userId, type: "subscription_activated",
          description: getSubscriptionActivationBenefits(plan).transaction.description,
          createdAt: { gte: initial.createdAt, lte: new Date(initial.createdAt.getTime() + 1000) } },
        select: { id: true },
      });
      const priorRenewal = initial && originalActivation && await tx.paymentEvent.findFirst({
        where: { userId, provider: PAYMENT_PROVIDER, kind: "subscription_renewal", planId: plan.id,
          amountRub: { gt: 0 }, createdAt: { gt: initial.createdAt } },
        orderBy: { createdAt: "desc" }, select: { amountRub: true },
      });
      approvedAmount = priorRenewal ? priorRenewal.amountRub : null;
    } else if (parent?.userId !== userId || !["subscription", "subscription_pending"].includes(parent.kind)
        || getSubscriptionPlan(parent.planId).id !== plan.id
        || (order && (order.userId !== userId || order.kind !== "subscription" || order.planId !== plan.id
          || order.amountRub !== approvedAmount))) {
      return { reason: "no_confirmed_agreement" } as const;
    }
    if (!approvedAmount || ROBOKASSA_TEST_MODE) return { reason: "no_confirmed_agreement" } as const;

    // Existing agreements without a checkout snapshot can use a known tariff price.
    const period = order?.period ?? (approvedAmount === plan.yearlyPrice ? "year" : approvedAmount === plan.monthlyPrice ? "month" : null);
    if (period !== "month" && period !== "year") return { reason: "no_confirmed_agreement" } as const;

    const invId = createRobokassaInvoiceId();
    const amountRub = approvedAmount;
    // Reserve the invoice under the account lock, before sending a potentially successful network request.
    await tx.transaction.create({ data: { userId, amount: 0, type: INITIATED_TYPE,
      description: initiatedPrefix + invId + " plan=" + plan.id + " period=" + period + " amount=" + amountRub,
    } });
    return { invId, parentId, amountRub, period, plan, email: user.email } as const;
  });
}

export async function renewSubscriptionIfDue(
  userId: string,
  options?: { force?: boolean; now?: Date }
): Promise<RenewSubscriptionResult> {
  const now = options?.now ?? new Date();
  const pending = await pendingCharge(userId);
  if (pending) {
    const settled = await settlePendingCharge(userId, pending, now);
    if (settled === "granted") {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { subscriptionEnd: true } });
      return { renewed: true, userId, invId: pending.invId, newEnd: user?.subscriptionEnd ?? undefined, period: pending.period };
    }
    if (settled === "pending") return { renewed: false, userId, invId: pending.invId, reason: "awaiting_confirmation" };
  }

  const reservation = await reserveRenewal(userId, now, options?.force === true);
  if (reservation.reason) return { renewed: false, userId, reason: reservation.reason };
  const { invId, parentId, amountRub, period, plan, email } = reservation;
  const desc = "Подписка " + plan.name + " на 1 " + (period === "year" ? "год" : "месяц");
  try {
    await chargeRobokassaRecurring({
      invoiceId: invId, previousInvoiceId: parentId, sum: amountRub, desc, email,
      extraShp: {
        Shp_userId: userId, Shp_subscription: "true", Shp_plan: plan.id, Shp_period: period,
        Shp_applyMode: "immediate", Shp_renewal: "true",
      },
      receipt: buildReceipt([{ name: desc, price: amountRub, quantity: 1 }]),
    });
    return { renewed: false, initiated: true, userId, invId };
  } catch (error) {
    // Keep the reservation. A timeout may mean the provider accepted the payment.
    errorLog("Subscription", "Renewal request not acknowledged", { userId, invId }, error);
    return { renewed: false, userId, invId, reason: "charge_failed" };
  }
}

/** Settles charges whose ResultURL was lost, including users whose period has already lapsed. */
async function reconcilePendingRenewals(now: Date) {
  const since = new Date(now.getTime() - RECONCILE_WINDOW_MS);
  const rows = await prisma.transaction.findMany({
    where: { type: INITIATED_TYPE, description: { startsWith: "Robokassa recurring initiated InvId=" }, createdAt: { gte: since } },
    distinct: ["userId"], select: { userId: true } });
  const outcomes: Array<{ userId: string; invId: string; outcome: "granted" | "declined" | "pending" }> = [];
  for (const { userId } of rows) {
    const charge = await pendingCharge(userId);
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
  return prisma.$executeRaw`UPDATE "User" SET "verseCoins" = "permanentCoins"
    WHERE "subscriptionEnd" < ${lapsedBefore} AND "verseCoins" > "permanentCoins"`;
}
