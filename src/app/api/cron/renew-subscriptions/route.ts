import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSubscriptionPlan } from "@/lib/chatEconomy";
import { buildReceipt, chargeRobokassaRecurring } from "@/lib/robokassa";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET || process.env.ADMIN_SECRET;
  if (!secret) {
    return false;
  }

  const authHeader = req.headers.get("Authorization");
  const cronHeader = req.headers.get("x-cron-secret");
  return authHeader === `Bearer ${secret}` || cronHeader === secret;
}

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

async function renewDueSubscriptions() {
  const now = new Date();
  const windowStart = addDays(now, -2);
  const windowEnd = addDays(now, 1);

  const users = await prisma.user.findMany({
    where: {
      robokassaRecurringId: { not: null },
      subscriptionEnd: { gte: windowStart, lte: windowEnd },
      isSubscribed: true,
    },
    select: {
      id: true,
      subscriptionType: true,
      subscriptionEnd: true,
      robokassaRecurringId: true,
      pendingSubscriptionType: true,
    },
  });

  const results: Array<{ userId: string; invId?: string; skipped?: string; error?: string }> = [];

  for (const user of users) {
    if (!user.robokassaRecurringId || !user.subscriptionEnd) {
      continue;
    }

    if (!isSubscriptionActive(user)) {
      results.push({ userId: user.id, skipped: "inactive" });
      continue;
    }

    const pendingPlan = user.pendingSubscriptionType
      ? getSubscriptionPlan(user.pendingSubscriptionType)
      : null;
    if (pendingPlan) {
      console.log(
        `[Robokassa] Renew skipped: user=${user.id} has pending=${pendingPlan.id}, RecurringID=${user.robokassaRecurringId}`
      );
      results.push({ userId: user.id, skipped: "pending_plan_change" });
      continue;
    }

    const plan = getSubscriptionPlan(user.subscriptionType);
    if (plan.monthlyPrice <= 0) {
      results.push({ userId: user.id, skipped: "free_plan" });
      continue;
    }

    const recentInit = await prisma.transaction.findFirst({
      where: {
        userId: user.id,
        type: "subscription_renewal_initiated",
        createdAt: { gte: addDays(now, -3) },
      },
      select: { id: true },
    });

    if (recentInit) {
      results.push({ userId: user.id, skipped: "already_initiated" });
      continue;
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

      await prisma.transaction.create({
        data: {
          userId: user.id,
          amount: 0,
          type: "subscription_renewal_initiated",
          description: `Robokassa recurring initiated InvId=${invId}`,
        },
      });

      results.push({ userId: user.id, invId });
    } catch (error) {
      results.push({
        userId: user.id,
        error: error instanceof Error ? error.message : "charge_failed",
      });
    }
  }

  return { checked: users.length, results };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  }

  try {
    const summary = await renewDueSubscriptions();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error("[Robokassa] Subscription renew cron error:", error);
    return NextResponse.json({ error: "Не удалось продлить подписки" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
