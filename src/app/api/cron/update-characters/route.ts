import { NextRequest, NextResponse } from "next/server";
import { errorLog, infoLog } from "@/lib/logger";
import { getCronProvidedSecret, logCronSecretCheck } from "@/lib/cronAuth";
// import { runCharacterLifecycleTick } from "@/lib/characterLifecycle";

// RelaxDev / cron-job.org: GET or POST /api/cron/update-characters
// Auth: Authorization: Bearer CRON_SECRET, x-cron-secret, or ?secret=
// Временно отключено. Будет использовано в будущем для расширенной системы живых персонажей.

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = getCronProvidedSecret(req);
  const check = logCronSecretCheck("Cron:UpdateCharacters", expected, provided);

  if (!check.configured) {
    errorLog("Cron:UpdateCharacters", "CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  if (!check.matched) {
    errorLog("Cron:UpdateCharacters", "secret check mismatch");
    return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  }

  infoLog("Cron:UpdateCharacters", "update-characters disabled");
  return NextResponse.json({ ok: true, message: "Disabled for now" });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
