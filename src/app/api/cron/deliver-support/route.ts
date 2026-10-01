import { NextRequest, NextResponse } from "next/server";
import { processSupportOutbox } from "@/lib/supportOutbox";
import { errorLog, infoLog } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 30;

function getProvidedSecret(req: NextRequest): string {
  return (
    req.nextUrl.searchParams.get("secret") ||
    req.headers.get("x-cron-secret") ||
    (req.headers.get("Authorization")?.startsWith("Bearer ")
      ? req.headers.get("Authorization")!.slice("Bearer ".length).trim()
      : "")
  );
}

async function handle(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || getProvidedSecret(req) !== expected) {
    return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  }
  try {
    const result = await processSupportOutbox(20);
    infoLog("Cron:SupportOutbox", "processed", result);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    errorLog("Cron:SupportOutbox", "failed", error);
    return NextResponse.json({ error: "Delivery failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
