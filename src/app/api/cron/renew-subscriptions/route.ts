import { NextRequest, NextResponse } from "next/server";
import { renewDueSubscriptions } from "@/lib/subscriptionRenewal";

function maskSecret(value: string | undefined | null): string {
  if (value == null || value === "") {
    return "(undefined)";
  }
  if (value.length <= 4) {
    return `*** (len=${value.length})`;
  }
  return `${value.slice(0, 2)}***${value.slice(-2)} (len=${value.length})`;
}

function getProvidedSecret(req: NextRequest): string {
  const querySecret = req.nextUrl.searchParams.get("secret");
  if (querySecret) {
    return querySecret;
  }

  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) {
    return cronHeader;
  }

  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  return "";
}

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = getProvidedSecret(req);

  console.log(`[Cron] CRON_SECRET=${maskSecret(expected)}`);
  console.log(`[Cron] provided secret=${maskSecret(provided)}`);

  if (!expected) {
    console.error("[Cron] CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  if (provided !== expected) {
    console.error(
      `Cron secret mismatch: expected ${maskSecret(expected)}, got ${maskSecret(provided)}`
    );
    return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  }

  try {
    const summary = await renewDueSubscriptions();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error("[Robokassa] Subscription renew cron error:", error);
    return NextResponse.json({ error: "Не удалось продлить подписки" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
