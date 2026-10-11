import { NextRequest, NextResponse } from "next/server";
import { reconcileAvatarBatch } from "@/lib/kieAvatarJobs";
import { getCronProvidedSecret } from "@/lib/cronAuth";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 180;
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || getCronProvidedSecret(req) !== secret) return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  try {
    const result = await reconcileAvatarBatch();
    infoLog("Cron:KieAvatar", "processed", result);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    errorLog("Cron:KieAvatar", "failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось проверить генерации" }, { status: 500 });
  }
}
export const GET = handle;
export const POST = handle;
