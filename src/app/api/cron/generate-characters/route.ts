import { NextRequest, NextResponse } from "next/server";
import { processGenerationStep, secretMatches } from "@/lib/characterGeneration";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 180;
export async function POST(req: NextRequest) {
  const provided = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? null;
  if (!secretMatches(process.env.CRON_SECRET, provided)) return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  try { return NextResponse.json(await processGenerationStep(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) {
    errorLog("CharacterGeneration", "Worker failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Обработка временно недоступна" }, { status: 503 });
  }
}
