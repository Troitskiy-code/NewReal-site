import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SUBSCRIPTION_PLANS, getSubscriptionActivationBenefits } from "@/lib/chatEconomy";
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
    console.error("[Robokassa] Webhook body parse error:", error instanceof Error ? error.message : error);
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

  console.log(`[Robokassa] Webhook keys: ${[...params.keys()].join(", ") || "(none)"}`);

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

  console.log(
    `[Robokassa] Recurring payload: Recurring=${recurringFlag || "none"}, RecurringID=${recurringId || "none"}, InvId=${invId || "none"}, Shp_subscription=${shpValue(shp, "Shp_subscription") || "none"}`
  );

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

  const isSubscription = shpValue(shp, "Shp_subscription").toLowerCase() === "true";

  if (existingPayment) {
    if (isSubscription) {
      const current = await prisma.user.findUnique({
        where: { id: userId },
        select: { robokassaRecurringId: true },
      });
      const nextRecurringId = storedRecurringId(recurringId, invId, current?.robokassaRecurringId);
      if (current && !current.robokassaRecurringId && nextRecurringId) {
        await prisma.user.update({
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

  if (isSubscription) {
    const planId = shpValue(shp, "Shp_plan").trim().toLowerCase() || (currentUser.subscriptionType ?? "");
    const period = shpValue(shp, "Shp_period").trim().toLowerCase() === "year" ? "year" : "month";
    const normalizedPlanId = planId === "history" ? "story" : planId;
    const plan = SUBSCRIPTION_PLANS.find((item) => item.id === normalizedPlanId);

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

      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: {
            subscriptionType: plan.id,
            subscriptionEnd,
            isSubscribed: true,
            robokassaRecurringId: nextRecurringId,
            ...benefits.user,
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
        prisma.transaction.create({
          data: {
            userId,
            amount: benefits.transaction.amount,
            type: benefits.transaction.type,
            description: benefits.transaction.description,
          },
        }),
      ]);

      console.log(
        `[Robokassa] Webhook processed successfully: InvId=${invId}, renewal=${plan.id}, period=${period}, robokassaRecurringId=${nextRecurringId}`
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
          `[Robokassa] Webhook processed successfully: InvId=${invId}, pending=${plan.id}, period=${period}, robokassaRecurringId=${nextRecurringId}`
        );
        return okResponse(invId);
      }
    }

    const subscriptionEnd = addSubscriptionDays(now, period === "year" ? 365 : 30);
    const benefits = getSubscriptionActivationBenefits(plan, now);

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
          ...benefits.user,
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
      prisma.transaction.create({
        data: {
          userId,
          amount: benefits.transaction.amount,
          type: benefits.transaction.type,
          description: benefits.transaction.description,
        },
      }),
    ]);

    console.log(
      `[Robokassa] Webhook processed successfully: InvId=${invId}, subscription=${plan.id}, period=${period}, robokassaRecurringId=${nextRecurringId}`
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
