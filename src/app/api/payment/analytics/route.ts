import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PAYMENT_PROVIDER } from "@/lib/paymentEvent";
import { normalizeInvId } from "@/lib/paymentStatus";
import { isDeclaredTestPayment, publicPaymentOrderId, paymentOrderMatchesEvent } from "@/lib/paymentOrders";
import { subscriptionGoal, METRIKA_GOALS } from "@/lib/metrika";
import { errorLog } from "@/lib/logger";
import { toSafeDiagnostic } from "@/lib/safeDiagnostics";
import { supportAdminOriginAllowed as trustedSiteOrigin } from "@/lib/supportAdmin";

const STATES = new Set(["attempt_started", "callback_completed", "timeout", "unknown"]);
export async function POST(req: NextRequest) {
  try {
    // Receipt is advisory, but keep it session-owned and same-origin.
    const origin = req.headers.get("origin");
    if (!origin || !trustedSiteOrigin(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const text = await req.text();
    if (text.length > 2048) return NextResponse.json({ error: "Invalid receipt" }, { status: 400 });
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid receipt" }, { status: 400 });
    const invoiceId = normalizeInvId(body.invoiceId);
    if (!invoiceId || typeof body.goal !== "string" || typeof body.orderId !== "string"
      || !STATES.has(body.state) || !Number.isInteger(body.attempts) || body.attempts < 1 || body.attempts > 3)
      return NextResponse.json({ error: "Invalid receipt" }, { status: 400 });
    return await prisma.$transaction(async (tx) => {
      const event = await tx.paymentEvent.findUnique({ where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId } } });
      if (!event || event.userId !== session.user.id) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const order = await tx.paymentOrder.findUnique({ where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId } } });
      const matched = paymentOrderMatchesEvent(order, event);
      const allowed = event.kind === "purchase" ? [METRIKA_GOALS.vcPurchaseSuccess] :
        event.kind === "subscription" || event.kind === "subscription_pending" ? [METRIKA_GOALS.subscriptionSuccess, subscriptionGoal(event.planId ?? "")] : [];
      if ((matched && order?.isTest) || isDeclaredTestPayment(event.userId) || body.orderId !== publicPaymentOrderId(event.id, matched ? order?.id : null)
        || !allowed.includes(body.goal)) return NextResponse.json({ error: "Invalid receipt" }, { status: 400 });
      // Atomic merge: late timeout/replay cannot replace callback_completed or lower attempts.
      await tx.$executeRaw`
        INSERT INTO "PaymentGoalReceipt" ("id", "eventId", "goal", "state", "attempts", "receivedAt")
        VALUES (${crypto.randomUUID()}, ${event.id}, ${body.goal}, ${body.state}, ${body.attempts}, CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        ON CONFLICT ("eventId", "goal") DO UPDATE SET
          "state" = CASE WHEN "PaymentGoalReceipt"."state" = 'callback_completed' OR EXCLUDED."state" = 'callback_completed' THEN 'callback_completed'
            WHEN EXCLUDED."attempts" > "PaymentGoalReceipt"."attempts" THEN EXCLUDED."state"
            WHEN EXCLUDED."attempts" = "PaymentGoalReceipt"."attempts" AND EXCLUDED."state" IN ('timeout','unknown') THEN EXCLUDED."state"
            ELSE "PaymentGoalReceipt"."state" END,
          "attempts" = GREATEST("PaymentGoalReceipt"."attempts", EXCLUDED."attempts"), "receivedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`;
      return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid receipt" }, { status: 400 });
    errorLog("PaymentAnalytics", "Unable to record client receipt", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Unable to record receipt" }, { status: 500 });
  }
}
