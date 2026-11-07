import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Этот способ оплаты отключён." },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}
