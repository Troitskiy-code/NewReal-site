import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PAYMENT_PROVIDER } from "@/lib/paymentEvent";
import { normalizeInvId } from "@/lib/paymentStatus";
import { isDeclaredTestPayment, publicPaymentOrderId, paymentOrderMatchesEvent } from "@/lib/paymentOrders";
import { subscriptionGoal, METRIKA_GOALS } from "@/lib/metrika";
import { errorLog, infoLog } from "@/lib/logger";
import { toSafeDiagnostic } from "@/lib/safeDiagnostics";
import { supportAdminOriginAllowed as trustedSiteOrigin } from "@/lib/supportAdmin";

const STATES = new Set(["attempt_started", "callback_completed", "timeout", "unknown"]);
export async function POST(req: NextRequest) {
  let verifiedInvoiceId: string | null = null;
  const reject = (error: string, status: number, reason: string) => {
    infoLog("PaymentAnalytics", "receipt_rejected", { at: new Date().toISOString(), status, reason,
      ...(verifiedInvoiceId ? { invoiceId: verifiedInvoiceId } : {}) });
    return NextResponse.json({ error }, { status });
  };
  try {
    // Receipt is advisory, but keep it session-owned and same-origin.
    const origin = req.headers.get("origin");
    if (!origin || !trustedSiteOrigin(req)) return reject("Forbidden", 403, "origin_not_allowed");
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return reject("Unauthorized", 401, "session_missing");
    const text = await req.text();
    if (text.length > 2048) return reject("Invalid receipt", 400, "body_too_large");
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return reject("Invalid receipt", 400, "invalid_body");
    const invoiceId = normalizeInvId(body.invoiceId);
    if (!invoiceId || typeof body.goal !== "string" || typeof body.orderId !== "string"
      || !STATES.has(body.state) || !Number.isInteger(body.attempts) || body.attempts < 1 || body.attempts > 3)
      return reject("Invalid receipt", 400, "invalid_fields");
    let saved: Record<string, string | number | null> | null = null;
    const response = await prisma.$transaction(async (tx) => {
      const event = await tx.paymentEvent.findUnique({ where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId } } });
      if (!event || event.userId !== session.user.id) return reject("Not found", 404, "event_not_owned");
      verifiedInvoiceId = event.invoiceId;
      const order = await tx.paymentOrder.findUnique({ where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId } } });
      const matched = paymentOrderMatchesEvent(order, event);
      const allowed = event.kind === "purchase" ? [METRIKA_GOALS.vcPurchaseSuccess] :
        event.kind === "subscription" || event.kind === "subscription_pending" ? [METRIKA_GOALS.subscriptionSuccess, subscriptionGoal(event.planId ?? "")] : [];
      if ((matched && order?.isTest) || isDeclaredTestPayment(event.userId) || body.orderId !== publicPaymentOrderId(event.id, matched ? order?.id : null)
        || !allowed.includes(body.goal)) return reject("Invalid receipt", 400, "receipt_not_allowed");
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
      saved = { invoiceId: event.invoiceId, orderId: publicPaymentOrderId(event.id, matched ? order?.id : null),
        kind: event.kind, amountRub: event.amountRub, goal: body.goal, reportedState: body.state, attempts: body.attempts };
      return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    });
    // Emit only after commit. This is a client report, not proof of Yandex acceptance.
    if (saved && response.ok) infoLog("PaymentAnalytics", "receipt_saved", { ...saved, at: new Date().toISOString(), status: 200 });
    return response;
  } catch (error) {
    if (error instanceof SyntaxError) return reject("Invalid receipt", 400, "invalid_json");
    errorLog("PaymentAnalytics", "Unable to record client receipt", toSafeDiagnostic(error));
    return reject("Unable to record receipt", 500, "persist_failed");
  }
}
