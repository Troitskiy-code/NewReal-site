import { NextResponse } from "next/server";

// Retired: this endpoint used to grant VC without a confirmed payment.
// Checkout uses /api/payment/create; only the signed payment webhook grants VC.
export async function POST() {
  return NextResponse.json(
    {
      error: "Прямое начисление VC отключено. Создайте платёж через /api/payment/create.",
      code: "DIRECT_VC_PURCHASE_DISABLED",
    },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}
