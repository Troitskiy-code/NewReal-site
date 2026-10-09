import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiT } from "@/lib/apiI18n";
import { normalizeInvId, visiblePaymentStatus, type PaymentStatusResponse } from "@/lib/paymentStatus";
import { PAYMENT_PROVIDER } from "@/lib/paymentEvent";
import { isDeclaredTestPayment, publicPaymentOrderId, paymentOrderMatchesEvent } from "@/lib/paymentOrders";

export type { PaymentStatusKind, PaymentStatusResponse } from "@/lib/paymentStatus";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: apiT(req, "api.unauthorized") }, { status: 401 });
  }

  const invId = normalizeInvId(req.nextUrl.searchParams.get("invId"));
  if (!invId) {
    return NextResponse.json({ status: "idle" } satisfies PaymentStatusResponse);
  }

  const event = await prisma.paymentEvent.findUnique({
    where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId: invId } },
    select: { id: true, userId: true, kind: true, planId: true, amountRub: true },
  });

  const result = visiblePaymentStatus(event, session.user.id, invId);
  if (result.status === "confirmed" && event) {
    const order = await prisma.paymentOrder.findUnique({
      where: { provider_invoiceId: { provider: PAYMENT_PROVIDER, invoiceId: invId } },
      select: { id: true, isTest: true, userId: true, kind: true, amountRub: true, planId: true },
    });
    const matched = paymentOrderMatchesEvent(order, event);
    result.orderId = publicPaymentOrderId(event.id, matched ? order?.id : null);
    result.analyticsExcluded = Boolean((matched && order?.isTest) || isDeclaredTestPayment(event.userId));
  }
  return NextResponse.json(result satisfies PaymentStatusResponse, { headers: { "Cache-Control": "no-store" } });
}
