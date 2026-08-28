import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SUBSCRIPTION_PLANS } from "@/lib/chatEconomy";
import { extractShpParams, verifyRobokassaResultSignature } from "@/lib/robokassa";
import { addSubscriptionDays } from "@/lib/subscriptionState";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";

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
  if (recurringId && recurringId !== invId) {
    return recurringId;
  }
  if (existing) {
    return existing;
  }
  return recurringId || invId;
}

async function parseWebhookPayload(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const queryOutSum = firstParam(params, "OutSum", "out_summ", "outsum");
  const queryInvId = firstParam(params, "InvId", "InvoiceID", "inv_id", "invid");
  const querySignature = firstParam(params, "SignatureValue", "crc", "signaturevalue");
  const queryShp = extractShpParams(params.entries());
  const queryRecurringId = firstParam(params, "RecurringID", "RecurringId", "recurringid", "PreviousInvoiceID");
  const queryRecurringFlag = firstParam(params, "Recurring", "recurring");

  if (queryOutSum && queryInvId && querySignature) {
    return {
      outSum: queryOutSum,
      invId: queryInvId,
      signature: querySignature,
      shp: queryShp,
      recurringId: queryRecurringId,
      recurringFlag: queryRecurringFlag,
    };
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const body = await req.formData();
    return {
      outSum: firstParam(body, "OutSum", "out_summ", "outsum"),
      invId: firstParam(body, "InvId", "InvoiceID", "inv_id", "invid"),
      signature: firstParam(body, "SignatureValue", "crc", "signaturevalue"),
      shp: extractShpParams(body.entries()),
      recurringId: firstParam(body, "RecurringID", "RecurringId", "recurringid", "PreviousInvoiceID"),
      recurringFlag: firstParam(body, "Recurring", "recurring"),
    };
  }

  return {
    outSum: queryOutSum,
    invId: queryInvId,
    signature: querySignature,
    shp: queryShp,
    recurringId: queryRecurringId,
    recurringFlag: queryRecurringFlag,
  };
}

function okResponse(invId: string) {
  return new NextResponse(`OK${invId}`, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function resolveUserId(shp: Record<string, string>, recurringId: string): Promise<string> {
  const fromShp = shpValue(shp, "Shp_userId");
  if (fromShp) {
    return fromShp;
  }

  if (!recurringId) {
    return "";
  }

  const owner = await prisma.user.findUnique({
    where: { robokassaRecurringId: recurringId },
    select: { id: true },
  });

  return owner?.id ?? "";
}

async function handleWebhook(req: NextRequest) {
  const { outSum, invId, signature, shp, recurringId, recurringFlag } = await parseWebhookPayload(req);
  const userId = await resolveUserId(shp, recurringId);

  if (recurringId || recurringFlag) {
    console.log(
      `[Robokassa] Recurring payload: Recurring=${recurringFlag || "none"}, RecurringID=${recurringId || "none"}`
    );
  }

  if (!outSum || !invId || !signature || !userId) {
    console.error("[Robokassa] Webhook error: Missing required fields");
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  if (!verifyRobokassaResultSignature(outSum, invId, signature, shp)) {
    console.error("[Robokassa] Webhook error: Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const paymentMarker = `Robokassa InvId=${invId}`;
  const existingPayment = await prisma.transaction.findFirst({
    where: {
      userId,
      description: paymentMarker,
    },
    select: { id: true },
  });

  if (existingPayment) {
    console.log(`[Robokassa] Webhook processed successfully: InvId=${invId}`);
    return okResponse(invId);
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      subscriptionType: true,
      subscriptionEnd: true,
      robokassaRecurringId: true,
    },
  });

  if (!currentUser) {
    console.error(`[Robokassa] Webhook error: User not found ${userId}`);
    return NextResponse.json({ error: "User not found" }, { status: 400 });
  }

  const isSubscription = shpValue(shp, "Shp_subscription").toLowerCase() === "true";
  if (isSubscription) {
    const planId = shpValue(shp, "Shp_plan").trim().toLowerCase() || (currentUser.subscriptionType ?? "");
    const period = shpValue(shp, "Shp_period").trim().toLowerCase() === "year" ? "year" : "month";
    const normalizedPlanId = planId === "history" ? "story" : planId;
    const plan = SUBSCRIPTION_PLANS.find((item) => item.id === normalizedPlanId);
    const nextRecurringId = storedRecurringId(recurringId, invId, currentUser.robokassaRecurringId);

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

    if (isRenewal) {
      const baseDate =
        currentUser.subscriptionEnd && currentUser.subscriptionEnd > now
          ? currentUser.subscriptionEnd
          : now;
      const subscriptionEnd = addSubscriptionDays(baseDate, period === "year" ? 365 : 30);

      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: {
            subscriptionType: plan.id,
            subscriptionEnd,
            isSubscribed: true,
            robokassaRecurringId: nextRecurringId,
          },
        }),
        prisma.transaction.create({
          data: {
            userId,
            amount: 0,
            type: "subscription_renewal",
            description: paymentMarker,
          },
        }),
      ]);

      console.log(
        `[Robokassa] Webhook processed successfully: InvId=${invId}, renewal=${plan.id}, period=${period}`
      );
      return okResponse(invId);
    }

    if (applyMode === "afterExpiry") {
      if (isSubscriptionActive(currentUser) && currentUser.subscriptionEnd) {
        const pendingEnd = addSubscriptionDays(
          currentUser.subscriptionEnd,
          period === "year" ? 365 : 30
        );

        await prisma.$transaction([
          prisma.user.update({
            where: { id: userId },
            data: {
              pendingSubscriptionType: plan.id,
              pendingSubscriptionEnd: pendingEnd,
              robokassaRecurringId: nextRecurringId,
            },
          }),
          prisma.transaction.create({
            data: {
              userId,
              amount: 0,
              type: "subscription_pending",
              description: paymentMarker,
            },
          }),
        ]);

        console.log(
          `[Robokassa] Webhook processed successfully: InvId=${invId}, pending=${plan.id}, period=${period}`
        );
        return okResponse(invId);
      }
    }

    const subscriptionEnd = addSubscriptionDays(now, period === "year" ? 365 : 30);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          subscriptionType: plan.id,
          subscriptionEnd,
          isSubscribed: true,
          pendingSubscriptionType: null,
          pendingSubscriptionEnd: null,
          robokassaRecurringId: nextRecurringId,
        },
      }),
      prisma.transaction.create({
        data: {
          userId,
          amount: 0,
          type: "subscription",
          description: paymentMarker,
        },
      }),
    ]);

    console.log(
      `[Robokassa] Webhook processed successfully: InvId=${invId}, subscription=${plan.id}, period=${period}`
    );
    return okResponse(invId);
  }

  const vcFromShp = Number(shpValue(shp, "Shp_vc"));
  const vcAmount = Number.isFinite(vcFromShp) && vcFromShp > 0
    ? vcFromShp
    : Math.round(Number(outSum) / 0.3);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { verseCoins: { increment: vcAmount } },
    }),
    prisma.transaction.create({
      data: {
        userId,
        amount: vcAmount,
        type: "purchase",
        description: paymentMarker,
      },
    }),
  ]);

  console.log(`[Robokassa] Webhook processed successfully: InvId=${invId}, vcAmount=${vcAmount}`);
  return okResponse(invId);
}

export async function POST(req: NextRequest) {
  try {
    return await handleWebhook(req);
  } catch (error) {
    console.error("[Robokassa] Webhook error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    return await handleWebhook(req);
  } catch (error) {
    console.error("[Robokassa] Webhook error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
