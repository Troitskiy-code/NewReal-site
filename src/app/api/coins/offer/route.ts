import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { firstVcAvailability } from "@/lib/firstVcPurchase";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  try {
    return NextResponse.json(await firstVcAvailability(session.user.id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    errorLog("Coins", "First offer lookup failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось проверить предложение" }, { status: 503 });
  }
}
