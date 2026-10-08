import { errorLog, toSafeDiagnostic } from "@/lib/logger";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { BillingService } from "@/lib/services/billing";

export async function POST(req) {
  try {
    const body = await req.text();
    const signature = req.headers.get("stripe-signature");
    const result = await BillingService.handleWebhook(body, signature);
    return NextResponse.json(result);
  } catch (error) {
    errorLog("Server", "[BILLING_WEBHOOK_ERROR]", toSafeDiagnostic(error));
    return new NextResponse("Операция временно недоступна", { status: 400 });
  }
}
