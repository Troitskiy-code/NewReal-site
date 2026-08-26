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

async function parseWebhookPayload(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const queryOutSum = firstParam(params, "OutSum", "out_summ", "outsum");
  const queryInvId = firstParam(params, "InvId", "inv_id", "invid");
  const querySignature = firstParam(params, "SignatureValue", "crc", "signaturevalue");
  const queryShp = extractShpParams(params.entries());

  if (queryOutSum && queryInvId && querySignature) {
    return {
      outSum: queryOutSum,
      invId: queryInvId,
      signature: querySignature,
      shp: queryShp,
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
      invId: firstParam(body, "InvId", "inv_id", "invid"),
      signature: firstParam(body, "SignatureValue", "crc", "signaturevalue"),
      shp: extractShpParams(body.entries()),
    };
  }

  return {
    outSum: queryOutSum,
    invId: queryInvId,
    signature: querySignature,
    shp: queryShp,
  };
}

function okResponse(invId: string) {
  return new NextResponse(`OK${invId}`, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function handleWebhook(req: NextRequest) {
  const { outSum, invId, signature, shp } = await parseWebhookPayload(req);
  const userId = shpValue(shp, "Shp_userId");

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

  const isSubscription = shpValue(shp, "Shp_subscription").toLowerCase() === "true";
  if (isSubscription) {
    const planId = shpValue(shp, "Shp_plan").trim().toLowerCase();
    const period = shpValue(shp, "Shp_period").trim().toLowerCase() === "year" ? "year" : "month";
    const normalizedPlanId = planId === "history" ? "story" : planId;
    const plan = SUBSCRIPTION_PLANS.find((item) => item.id === normalizedPlanId);

    if (!plan || plan.monthlyPrice <= 0) {
      console.error(`[Robokassa] Webhook error: Unknown subscription plan "${planId}"`);
      return NextResponse.json({ error: "Unknown subscription plan" }, { status: 400 });
    }

    const now = new Date();
    const applyMode = shpValue(shp, "Shp_applyMode").trim() === "afterExpiry" ? "afterExpiry" : "immediate";

    if (applyMode === "afterExpiry") {
      const currentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          subscriptionType: true,
          subscriptionEnd: true,
        },
      });

      if (currentUser && isSubscriptionActive(currentUser) && currentUser.subscriptionEnd) {
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

    const subscriptionEnd = new Date(now);
    if (period === "year") {
      subscriptionEnd.setDate(subscriptionEnd.getDate() + 365);
    } else {
      subscriptionEnd.setDate(subscriptionEnd.getDate() + 30);
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          subscriptionType: plan.id,
          subscriptionEnd,
          isSubscribed: true,
          pendingSubscriptionType: null,
          pendingSubscriptionEnd: null,
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
