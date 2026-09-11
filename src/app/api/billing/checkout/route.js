import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { BillingService } from "@/lib/services/billing";
import { rejectUnverifiedEmail } from "@/lib/emailVerification";

export async function POST(req) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return new NextResponse("Unauthorized", { status: 401 });

    const unverified = await rejectUnverifiedEmail(req, session.user.id, "api.confirmEmailToPurchase");
    if (unverified) return unverified;

    const { planId } = await req.json();
    const url = await BillingService.createCheckoutSession(session.user.id, planId);
    return NextResponse.json({ url });
  } catch (error) {
    console.error("[BILLING_CHECKOUT_ERROR]", error);
    return new NextResponse(error.message || "Internal Error", { status: 500 });
  }
}
