import { NextRequest, NextResponse } from "next/server";
import { backfillDeepinfraEmbeddings, embeddingBackfillStatus } from "@/lib/embeddingBackfill";
import { getCronProvidedSecret } from "@/lib/cronAuth";
import { infoLog, errorLog, toSafeDiagnostic } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 180;
async function handle(req: NextRequest, apply: boolean) {
  const expected = process.env.CRON_SECRET;
  if (!expected || getCronProvidedSecret(req) !== expected) return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  try {
    const result = apply ? await backfillDeepinfraEmbeddings() : await embeddingBackfillStatus();
    if (apply) infoLog("Cron:EmbeddingBackfill", "processed", result);
    const failed = "failed" in result && result.failed > 0;
    return NextResponse.json({ ok: !failed, ...result }, { status: failed ? 503 : 200 });
  } catch (error) {
    errorLog("Cron:EmbeddingBackfill", "failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось обработать индекс памяти" }, { status: 503 });
  }
}
// Opening this URL is safe: only POST performs billable embedding work.
export const GET = (req: NextRequest) => handle(req, false);
export const POST = (req: NextRequest) => handle(req, true);
