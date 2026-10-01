import { NextRequest, NextResponse } from "next/server";
import { processSupportOutbox } from "@/lib/supportOutbox";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { getCronProvidedSecret } from "@/lib/cronAuth";

export const runtime = "nodejs";
export const maxDuration = 30;

async function handle(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = getCronProvidedSecret(req);
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  }
  try {
    const result = await processSupportOutbox(20);
    infoLog("Cron:SupportOutbox", "processed", result);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    errorLog("Cron:SupportOutbox", "failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Delivery failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
