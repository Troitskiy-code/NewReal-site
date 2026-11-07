import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SUBSCRIPTION_PLANS, getSubscriptionActivationBenefits } from "@/lib/chatEconomy";
import { extractShpParams, verifyRobokassaResultSignature, ROBOKASSA_TEST_MODE } from "@/lib/robokassa";
import { addSubscriptionDays } from "@/lib/subscriptionState";
import { findRenewalCharge, grantConfirmedRenewal } from "@/lib/subscriptionRenewal";
import { confirmedPendingInvoice, pendingPaymentMarker } from "@/lib/subscription";
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
    testPayment: /^(?:1|true)$/i.test(firstParam(lookup, "IsTest")),
  };
}

function okResponse(invId: string) {
  return new NextResponse(`OK${invId}`, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function formatSubscriptionEnd(date: Date): string {
  return date.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

async function handleWebhook(req: NextRequest) {
  const { outSum, invId, signature, shp, testPayment } = await parseWebhookPayload(req);
  const userId = shpValue(shp, "Shp_userId");
  const amountRub = parseConfirmedAmountRub(outSum);

  if (!userId || !signature || !/^\d{1,20}$/.test(invId) || amountRub === null) {
    return NextResponse.json({ error: "Invalid payment fields" }, { status: 400 });
  }
  if (ROBOKASSA_TEST_MODE || testPayment || !verifyRobokassaResultSignature(outSum, invId, signature, shp)) {
    return NextResponse.json({ error: "Invalid live payment signature" }, { status: 403 });
  }

  return prisma.$transaction(async tx => {
    const owners = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    if (!owners.length) return NextResponse.json({ error: "User not found" }, { status: 400 });

    const key = { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId: invId } };
    const existing = await tx.paymentEvent.findUnique({ where: key, select: { userId: true } });
    if (existing) {
      return existing.userId === userId ? okResponse(invId)
        : NextResponse.json({ error: "Invoice owner conflict" }, { status: 409 });
    }

    const subscription = shpValue(shp, "Shp_subscription").toLowerCase() === "true";
    const planId = shpValue(shp, "Shp_plan").trim().toLowerCase().replace(/^history$/, "story");
    const period = shpValue(shp, "Shp_period");
    const now = new Date();
    if (shpValue(shp, "Shp_renewal").toLowerCase() === "true") {
      const charge = await findRenewalCharge(tx, userId, invId);
      if (!subscription || !charge || charge.planId !== planId || charge.period !== period || charge.amountRub !== amountRub) {
        return NextResponse.json({ error: "Renewal does not match reserved invoice" }, { status: 409 });
      }
      await grantConfirmedRenewal(tx, userId, charge, now);
      return okResponse(invId);
    }

    const order = await tx.paymentOrder.findUnique({ where: key });
    if (!order || order.userId !== userId || order.amountRub !== amountRub
        || order.kind !== (subscription ? "subscription" : "purchase")) {
      errorLog("Robokassa", "Signed payment does not match its stored order", { invoiceId: invId });
      return NextResponse.json({ error: "Payment does not match stored order" }, { status: 409 });
    }

    const paymentMarker = "Robokassa InvId=" + invId;
    if (subscription) {
      const plan = SUBSCRIPTION_PLANS.find(item => item.id === planId && item.monthlyPrice > 0);
      const mode = shpValue(shp, "Shp_applyMode");
      if (!plan || order.planId !== plan.id || order.period !== period || !["month", "year"].includes(period)
          || !["immediate", "afterExpiry"].includes(mode)) {
        return NextResponse.json({ error: "Subscription does not match stored order" }, { status: 409 });
      }

      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: {
        subscriptionType: true, subscriptionEnd: true, pendingSubscriptionType: true,
        pendingSubscriptionEnd: true, robokassaRecurringId: true, verseCoins: true, permanentCoins: true,
      } });
      if (user.pendingSubscriptionType && user.pendingSubscriptionEnd
          && await confirmedPendingInvoice(tx, { id: userId, ...user })) {
        errorLog("Robokassa", "Paid invoice conflicts with an existing prepaid change", { invoiceId: invId });
        return NextResponse.json({ error: "An existing prepaid change must be applied first" }, { status: 409 });
      }

      const days = period === "year" ? 365 : 30;
      if (mode === "afterExpiry" && user.subscriptionEnd && isSubscriptionActive(user)) {
        const pendingEnd = addSubscriptionDays(user.subscriptionEnd, days);
        await tx.paymentEvent.create({
          data: paymentEventCreateData(invId, userId, "subscription_pending", { planId, amountRub }),
        });
        await tx.user.update({ where: { id: userId }, data: {
          pendingSubscriptionType: planId, pendingSubscriptionEnd: pendingEnd, robokassaRecurringId: invId,
        } });
        await tx.transaction.create({ data: { userId, amount: 0, type: "subscription_pending",
          description: pendingPaymentMarker(invId, pendingEnd) } });
        return okResponse(invId);
      }

      // A same-tariff purchase extends an active paid period. Do not carry forward a period
      // created by the retired direct-change route.
      const latestActivation = user.subscriptionEnd && isSubscriptionActive(user) && user.subscriptionType === plan.id
        ? await tx.transaction.findFirst({ where: { userId, type: "subscription_activated" },
            orderBy: { createdAt: "desc" }, select: { description: true, createdAt: true } }) : null;
      const latestPayment = latestActivation && !latestActivation.description?.startsWith("Смена подписки на ")
        ? await tx.paymentEvent.findFirst({ where: { provider: PAYMENT_PROVIDER, userId, planId,
            kind: { in: ["subscription", "subscription_pending", "subscription_renewal"] },
            amountRub: { gt: 0 }, createdAt: { lte: latestActivation.createdAt } }, select: { id: true } }) : null;
      const subscriptionEnd = addSubscriptionDays(latestPayment && user.subscriptionEnd ? user.subscriptionEnd : now, days);
      const benefits = getSubscriptionActivationBenefits(plan, now);
      const coinData = applySubscriptionCoinGrant({ id: userId, ...user }, benefits.vcGrant);
      await tx.paymentEvent.create({
        data: paymentEventCreateData(invId, userId, "subscription", { planId, amountRub }),
      });
      await tx.user.update({ where: { id: userId }, data: {
        subscriptionType: plan.id, subscriptionEnd, isSubscribed: true,
        pendingSubscriptionType: null, pendingSubscriptionEnd: null, robokassaRecurringId: invId,
        ...benefits.user, ...coinData,
      } });
      await tx.transaction.create({ data: { userId, amount: 0, type: "subscription", description: paymentMarker } });
      await tx.transaction.create({ data: { userId, ...benefits.transaction } });
      await tx.notification.create({ data: { userId, type: "purchase_subscription", title: "Подписка активирована",
        message: "Подписка «" + plan.name + "» активна до " + formatSubscriptionEnd(subscriptionEnd) + ".",
        link: "/subscription" } });
      return okResponse(invId);
    }

    const pkg = order.packageId === null ? undefined : getVcPackage(order.packageId);
    const offer = shpValue(shp, "Shp_offer");
    if (!pkg || shpValue(shp, "Shp_type") !== "vc" || shpValue(shp, "Shp_packageId") !== String(pkg.id)
        || shpValue(shp, "Shp_vc") !== String(pkg.vc)) {
      return NextResponse.json({ error: "VC package does not match stored order" }, { status: 409 });
    }
    const firstClaim = await tx.firstVcPurchase.findUnique({ where: { invoiceId: invId } });
    const firstOffer = pkg.id === FIRST_VC_PACKAGE.id;
    if (firstOffer ? (!firstClaim || firstClaim.userId !== userId || firstClaim.status !== "pending" || offer !== "first")
        : Boolean(firstClaim || offer)) {
      return NextResponse.json({ error: "Invalid first purchase reservation" }, { status: 409 });
    }

    await tx.paymentEvent.create({ data: paymentEventCreateData(invId, userId, "purchase", { amountRub }) });
    await tx.user.update({ where: { id: userId }, data: grantPermanentUpdate(pkg.vc) });
    await tx.transaction.create({ data: { userId, amount: pkg.vc, type: "purchase", description: paymentMarker } });
    if (firstOffer) await tx.firstVcPurchase.update({ where: { userId }, data: { status: "completed" } });
    await tx.notification.create({ data: { userId, type: "purchase_vc", title: "VerseCoins зачислены",
      message: "На ваш баланс зачислено " + pkg.vc + " VC.", link: "/coins" } });
    return okResponse(invId);
  });
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
