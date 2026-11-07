import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "По вопросам отмены оплаченного тарифа обратитесь в поддержку." },
    { status: 410, headers: { "Cache-Control": "no-store" } }
  );
}
