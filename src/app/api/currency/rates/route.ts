import { NextResponse } from "next/server";
import { getCurrencyRates } from "@/lib/currencyRates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rates = await getCurrencyRates();
  return NextResponse.json(rates, {
    headers: {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
