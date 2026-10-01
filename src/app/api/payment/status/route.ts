import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiT } from "@/lib/apiI18n";
import { normalizeInvId } from "@/lib/paymentStatus";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: apiT(req, "api.unauthorized") }, { status: 401 });
  }

  const invId = normalizeInvId(req.nextUrl.searchParams.get("invId"));
  if (!invId) {
    return NextResponse.json({ status: "idle" });
  }

  const event = await prisma.paymentEvent.findUnique({
    where: { provider_invoiceId: { provider: "robokassa", invoiceId: invId } },
    select: { userId: true },
  });
  const status = event?.userId === session.user.id ? "confirmed" : "pending";
  return NextResponse.json({ status, invId });
}
