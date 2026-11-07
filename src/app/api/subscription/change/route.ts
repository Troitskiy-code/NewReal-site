import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Для смены тарифа оформите подписку на странице тарифов.", checkout: "/pricing" },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}
