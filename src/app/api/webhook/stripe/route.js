import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { BillingService } from "@/lib/services/billing";

export async function POST(req) {
  try {
    const body = await req.text();
    const headersList = await headers();
    const signature = headersList.get("stripe-signature");

    if (!signature) {
      return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
    }

    const result = await BillingService.handleWebhook(body, signature);
    return NextResponse.json(result);
  } catch (error) {
    errorLog("Server", "Stripe webhook processing error:", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Операция временно недоступна" }, { status: 500 });
  }
}
