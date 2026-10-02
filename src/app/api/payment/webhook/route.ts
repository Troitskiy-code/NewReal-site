import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SUBSCRIPTION_PLANS, getSubscriptionActivationBenefits } from "@/lib/chatEconomy";
import { extractShpParams, verifyRobokassaResultSignature } from "@/lib/robokassa";
import { addSubscriptionDays } from "@/lib/subscriptionState";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";
import { applySubscriptionCoinGrant, grantPermanentUpdate } from "@/lib/verseCoins";
import { paymentEventCreateData, parseConfirmedAmountRub, PAYMENT_PROVIDER } from "@/lib/paymentEvent";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { FIRST_VC_PACKAGE, getVcPackage } from "@/lib/vcPackages";

function firstParam(
  source: { get(name: string): string | File | null },
  ...names: string[]
): string {
  for (const name of names) {
    const value = source.get(name);
    if (value !== null && value !== undefined && String(value) !== "") {
      return String(value);
    }
  }
  return "";
}

function shpValue(shp: Record<string, string>, name: string): string {
  const target = name.toLowerCase();
  const match = Object.entries(shp).find(([key]) => key.toLowerCase() === target);
  return match?.[1] ?? "";
}

function storedRecurringId(recurringId: string, invId: string, existing?: string | null): string {
  // Child charge: Robokassa may send the parent id as RecurringID / PreviousInvoiceID.
  if (recurringId && recurringId !== invId) {
    return recurringId;
  }
  // Parent payment: ResultURL usually has no RecurringID. The parent InvId is the series id
  // used later as PreviousInvoiceID.
  if (!existing || existing === invId) {
    return invId;
  }
  return existing;
}

function mergeParam(target: Map<string, string>, key: string, value: unknown) {
  if (value === null || value === undefined || value === "") {
    return;
  }
  target.set(key, String(value));
}

async function collectWebhookParams(req: NextRequest): Promise<Map<string, string>> {
  const merged = new Map<string, string>();

  for (const [key, value] of req.nextUrl.searchParams.entries()) {
    mergeParam(merged, key, value);
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return merged;
  }

  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const body = await req.json();
      if (body && typeof body === "object" && !Array.isArray(body)) {
        for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
          mergeParam(merged, key, value);
        }
      }
      return merged;
    }

    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const body = await req.formData();
      for (const [key, value] of body.entries()) {
        mergeParam(merged, key, value);
      }
      return merged;
    }

    const text = (await req.text()).trim();
    if (!text) {
      return merged;
    }

    try {
      const json = JSON.parse(text) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) {
        for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
          mergeParam(merged, key, value);
        }
        return merged;
      }
    } catch {
      // Not JSON — parse as querystring / form body.
    }

    const asParams = new URLSearchParams(text);
    for (const [key, value] of asParams.entries()) {
      mergeParam(merged, key, value);
    }
  } catch (error) {
    errorLog("Robokassa", "Webhook body parse error", toSafeDiagnostic(error));
  }

  return merged;
}

async function parseWebhookPayload(req: NextRequest) {
  const params = await collectWebhookParams(req);
  const lookup = {
    get(name: string) {
      const direct = params.get(name);
      if (direct) {
        return direct;
      }
      const match = [...params.entries()].find(([key]) => key.toLowerCase() === name.toLowerCase());
      return match?.[1] ?? null;
    },
  };

  // Parameter names are supplied by the caller too; never log arbitrary input.

  return {
    outSum: firstParam(lookup, "OutSum", "out_summ", "outsum"),
    invId: firstParam(lookup, "InvId", "InvoiceID", "inv_id", "invid"),
    signature: firstParam(lookup, "SignatureValue", "crc", "signaturevalue"),
    shp: extractShpParams(params.entries()),
    recurringId: firstParam(lookup, "RecurringID", "RecurringId", "recurringid", "PreviousInvoiceID"),
    recurringFlag: firstParam(lookup, "Recurring", "recurring"),
  };
}

function okResponse(invId: string) {
  return new NextResponse(`OK${invId}`, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function commitPaymentGrant(operations: Prisma.PrismaPromise<unknown>[]) {
  for (const operation of operations) await operation;
  return { duplicate: false as const };
}

function formatSubscriptionEnd(date: Date): string {
  return date.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

async function notifySubscriptionActivated(
  tx: Prisma.TransactionClient,
  userId: string,
  planName: string,
  subscriptionEnd: Date
) {
  await tx.notification.create({ data: { userId, type: "purchase_subscription", title: "Подписка активирована",
    message: `Подписка «${planName}» активна до ${formatSubscriptionEnd(subscriptionEnd)}.`, link: "/subscription" } });
}

async function handleWebhook(req: NextRequest) {
  const { outSum, invId, signature, shp, recurringId } = await parseWebhookPayload(req);
  const userId = shpValue(shp, "Shp_userId");

  if (!outSum || !invId || !signature || !userId) {
    console.error("[Robokassa] Webhook error: Missing required fields");
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (!verifyRobokassaResultSignature(outSum, invId, signature, shp)) {
    console.error("[Robokassa] Webhook error: Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  if (!/^\d{1,20}$/.test(invId) || parseConfirmedAmountRub(outSum) === null) {
    return NextResponse.json({ error: "Invalid payment amount or invoice" }, { status: 400 });
  }
  return prisma.$transaction(async (tx) => {
    const owners = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    if (!owners.length) return NextResponse.json({ error: "User not found" }, { status: 400 });
    return processConfirmedPayment(tx, { outSum, invId, shp, recurringId, userId });
  });
}

async function processConfirmedPayment(tx: Prisma.TransactionClient, payload: {
  outSum: string; invId: string; shp: Record<string, string>; recurringId: string; userId: string;
}) {
  const { outSum, invId, shp, recurringId, userId } = payload;

  const paymentMarker = `Robokassa InvId=${invId}`;
  const existingPayment = await tx.paymentEvent.findUnique({
    where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId: invId } },
    select: { id: true, userId: true },
  });

  const isSubscription = shpValue(shp, "Shp_subscription").toLowerCase() === "true";
  const amountRub = parseConfirmedAmountRub(outSum);

  if (existingPayment) {
    if (existingPayment.userId !== userId) return NextResponse.json({ error: "Invoice owner conflict" }, { status: 409 });
    if (isSubscription) {
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { robokassaRecurringId: true },
      });
      const nextRecurringId = storedRecurringId(recurringId, invId, current?.robokassaRecurringId);
      if (current && !current.robokassaRecurringId && nextRecurringId) {
        await tx.user.update({
          where: { id: userId },
          data: { robokassaRecurringId: nextRecurringId },
        });
        console.log(
          `[Robokassa] Backfilled robokassaRecurringId=${nextRecurringId} user=${userId} InvId=${invId}`
        );
      }
    }
    console.log(`[Robokassa] Webhook processed successfully: InvId=${invId}`);
    return okResponse(invId);
  }

  const currentUser = await tx.user.findUnique({
    where: { id: userId },
    select: {
      subscriptionType: true,
      subscriptionEnd: true,
      robokassaRecurringId: true,
      verseCoins: true,
      permanentCoins: true,
    },
  });

  if (!currentUser) {
    console.error(`[Robokassa] Webhook error: User not found ${userId}`);
    return NextResponse.json({ error: "User not found" }, { status: 400 });
  }

  if (isSubscription) {
    const shpPlanRaw = shpValue(shp, "Shp_plan").trim().toLowerCase();
    const planId = shpPlanRaw || (currentUser.subscriptionType ?? "");
    const period = shpValue(shp, "Shp_period").trim().toLowerCase() === "year" ? "year" : "month";
    const normalizedPlanId = planId === "history" ? "story" : planId;
    const plan = SUBSCRIPTION_PLANS.find((item) => item.id === normalizedPlanId);
    const analyticsPlanId = shpPlanRaw ? plan?.id ?? null : null;

    if (!plan || plan.monthlyPrice <= 0) {
      console.error(`[Robokassa] Webhook error: Unknown subscription plan "${planId}"`);
      return NextResponse.json({ error: "Unknown subscription plan" }, { status: 400 });
    }

    const now = new Date();
    const applyMode = shpValue(shp, "Shp_applyMode").trim() === "afterExpiry" ? "afterExpiry" : "immediate";
    const isRenewal =
      (Boolean(recurringId) && recurringId !== invId) ||
      (Boolean(currentUser.robokassaRecurringId) &&
        currentUser.robokassaRecurringId !== invId &&
        isSubscriptionActive(currentUser) &&
        (currentUser.subscriptionType ?? "") === plan.id &&
        applyMode !== "afterExpiry");

    // New parent payment: RecurringID is usually absent, so store InvId.
    // Renewals keep the existing parent RecurringID.
    const nextRecurringId = storedRecurringId(
      recurringId,
      invId,
      isRenewal ? currentUser.robokassaRecurringId : null
    );
    console.log(
      `[Robokassa] Will store robokassaRecurringId=${nextRecurringId} user=${userId} RecurringID=${recurringId || "none"} InvId=${invId}`
    );

    if (isRenewal) {
      const baseDate =
        currentUser.subscriptionEnd && currentUser.subscriptionEnd > now
          ? currentUser.subscriptionEnd
          : now;
      const subscriptionEnd = addSubscriptionDays(baseDate, period === "year" ? 365 : 30);
      const benefits = getSubscriptionActivationBenefits(plan, now);
      const coinData = applySubscriptionCoinGrant(
        { id: userId, verseCoins: currentUser.verseCoins, permanentCoins: currentUser.permanentCoins },
        benefits.vcGrant
      );

      const renewalCommit = await commitPaymentGrant([
        tx.paymentEvent.create({
          data: paymentEventCreateData(invId, userId, "subscription_renewal", {
            planId: analyticsPlanId,
            amountRub,
          }),
        }),
        tx.user.update({
          where: { id: userId },
          data: {
            subscriptionType: plan.id,
            subscriptionEnd,
            isSubscribed: true,
            robokassaRecurringId: nextRecurringId,
            ...benefits.user,
            ...coinData,
          },
        }),
        tx.transaction.create({
          data: {
            userId,
            amount: 0,
            type: "subscription_renewal",
            description: paymentMarker,
          },
        }),
        tx.transaction.create({
          data: {
            userId,
            amount: benefits.transaction.amount,
            type: benefits.transaction.type,
            description: benefits.transaction.description,
          },
        }),
      ]);
      if (renewalCommit.duplicate) {
        return okResponse(invId);
      }

      console.log(
        `[Robokassa] Webhook processed successfully: InvId=${invId}, renewal=${plan.id}, period=${period}, robokassaRecurringId=${nextRecurringId}`
      );
      await notifySubscriptionActivated(tx, userId, plan.name, subscriptionEnd);
      return okResponse(invId);
    }

    if (applyMode === "afterExpiry") {
      if (isSubscriptionActive(currentUser) && currentUser.subscriptionEnd) {
        const pendingEnd = addSubscriptionDays(
          currentUser.subscriptionEnd,
          period === "year" ? 365 : 30
        );

        const pendingCommit = await commitPaymentGrant([
          tx.paymentEvent.create({
            data: paymentEventCreateData(invId, userId, "subscription_pending", {
              planId: analyticsPlanId,
              amountRub,
            }),
          }),
          tx.user.update({
            where: { id: userId },
            data: {
              pendingSubscriptionType: plan.id,
              pendingSubscriptionEnd: pendingEnd,
              robokassaRecurringId: nextRecurringId,
            },
          }),
          tx.transaction.create({
            data: {
              userId,
              amount: 0,
              type: "subscription_pending",
              description: paymentMarker,
            },
          }),
        ]);
        if (pendingCommit.duplicate) {
          return okResponse(invId);
        }

        console.log(
          `[Robokassa] Webhook processed successfully: InvId=${invId}, pending=${plan.id}, period=${period}, robokassaRecurringId=${nextRecurringId}`
        );
        return okResponse(invId);
      }
    }

    const subscriptionEnd = addSubscriptionDays(now, period === "year" ? 365 : 30);
    const benefits = getSubscriptionActivationBenefits(plan, now);
    const coinData = applySubscriptionCoinGrant(
      { id: userId, verseCoins: currentUser.verseCoins, permanentCoins: currentUser.permanentCoins },
      benefits.vcGrant
    );

    const subCommit = await commitPaymentGrant([
      tx.paymentEvent.create({
        data: paymentEventCreateData(invId, userId, "subscription", {
          planId: analyticsPlanId,
          amountRub,
        }),
      }),
      tx.user.update({
        where: { id: userId },
        data: {
          subscriptionType: plan.id,
          subscriptionEnd,
          isSubscribed: true,
          pendingSubscriptionType: null,
          pendingSubscriptionEnd: null,
          robokassaRecurringId: nextRecurringId,
          ...benefits.user,
          ...coinData,
        },
      }),
      tx.transaction.create({
        data: {
          userId,
          amount: 0,
          type: "subscription",
          description: paymentMarker,
        },
      }),
      tx.transaction.create({
        data: {
          userId,
          amount: benefits.transaction.amount,
          type: benefits.transaction.type,
          description: benefits.transaction.description,
        },
      }),
    ]);
    if (subCommit.duplicate) {
      return okResponse(invId);
    }

    console.log(
      `[Robokassa] Webhook processed successfully: InvId=${invId}, subscription=${plan.id}, period=${period}, robokassaRecurringId=${nextRecurringId}`
    );
    await notifySubscriptionActivated(tx, userId, plan.name, subscriptionEnd);
    return okResponse(invId);
  }

  const vcFromShp = Number(shpValue(shp, "Shp_vc"));
  const packageIdRaw = shpValue(shp, "Shp_packageId");
  const packageId = Number(packageIdRaw);
  const firstClaim = await tx.firstVcPurchase.findUnique({ where: { invoiceId: invId } });
  const firstOffer = shpValue(shp, "Shp_offer") === "first" || packageId === FIRST_VC_PACKAGE.id || Boolean(firstClaim);
  if (firstOffer && (!firstClaim || firstClaim.userId !== userId || firstClaim.status !== "pending"
      || packageId !== FIRST_VC_PACKAGE.id || shpValue(shp, "Shp_offer") !== "first"
      || Number(outSum) !== FIRST_VC_PACKAGE.price || vcFromShp !== FIRST_VC_PACKAGE.vc)) {
    return NextResponse.json({ error: "Invalid first purchase reservation" }, { status: 409 });
  }
  if (packageIdRaw) {
    const pkg = getVcPackage(packageId);
    if (!pkg || Number(outSum) !== pkg.price || vcFromShp !== pkg.vc) {
      return NextResponse.json({ error: "Invalid VC package" }, { status: 400 });
    }
  }
  const vcAmount = Number.isFinite(vcFromShp) && vcFromShp > 0
    ? vcFromShp
    : Math.round(Number(outSum) / 0.3);
  if (!Number.isSafeInteger(vcAmount) || vcAmount <= 0 || vcAmount > 2_000_000_000) {
    return NextResponse.json({ error: "Invalid VC amount" }, { status: 400 });
  }

  const purchaseCommit = await commitPaymentGrant([
    tx.paymentEvent.create({
      data: paymentEventCreateData(invId, userId, "purchase", { amountRub }),
    }),
    tx.user.update({
      where: { id: userId },
      data: grantPermanentUpdate(vcAmount),
    }),
    tx.transaction.create({
      data: {
        userId,
        amount: vcAmount,
        type: "purchase",
        description: paymentMarker,
      },
    }),
  ]);
  if (purchaseCommit.duplicate) {
    return okResponse(invId);
  }
  if (firstOffer) await tx.firstVcPurchase.update({ where: { userId }, data: { status: "completed" } });

  console.log(`[Robokassa] Webhook processed successfully: InvId=${invId}, vcAmount=${vcAmount}`);
  await tx.notification.create({ data: { userId, type: "purchase_vc", title: "VerseCoins зачислены",
    message: `На ваш баланс зачислено ${vcAmount} VC.`, link: "/coins" } });
  return okResponse(invId);
}

export async function POST(req: NextRequest) {
  try {
    return await handleWebhook(req);
  } catch (error) {
    errorLog("Robokassa", "Webhook error", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
