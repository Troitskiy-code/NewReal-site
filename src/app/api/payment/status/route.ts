import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiT } from "@/lib/apiI18n";
import { normalizeInvId, visiblePaymentStatus, type PaymentStatusResponse } from "@/lib/paymentStatus";
import { PAYMENT_PROVIDER } from "@/lib/paymentEvent";

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
    select: { userId: true, kind: true, planId: true, amountRub: true },
  });

  return NextResponse.json(visiblePaymentStatus(event, session.user.id, invId) satisfies PaymentStatusResponse);
}
