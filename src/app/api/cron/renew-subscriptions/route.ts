import { NextRequest, NextResponse } from "next/server";
import { renewDueSubscriptions } from "@/lib/subscriptionRenewal";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { getCronProvidedSecret, logCronSecretCheck } from "@/lib/cronAuth";

// RelaxDev / cron-job.org: GET or POST /api/cron/renew-subscriptions
// Auth: Authorization: Bearer CRON_SECRET, x-cron-secret, or ?secret=

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = getCronProvidedSecret(req);
  const check = logCronSecretCheck("Cron:RenewSubscriptions", expected, provided);

  if (!check.configured) {
    errorLog("Cron:RenewSubscriptions", "CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  if (!check.matched) {
    errorLog("Cron:RenewSubscriptions", "secret check mismatch");
    return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  }

  try {
    infoLog("Cron:RenewSubscriptions", "Looking for users with expired subscriptions");
    const summary = await renewDueSubscriptions();
    infoLog("Cron:RenewSubscriptions", "Renewal summary", {
      checked: summary.checked,
      renewed: summary.results.filter((item) => !item.skipped && !item.error).length,
      failed: summary.results.filter((item) => Boolean(item.error)).length,
      skipped: summary.results.filter((item) => Boolean(item.skipped)).length,
      expiredCoins: summary.expiredCoins,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    errorLog("Cron:RenewSubscriptions", "renew failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось продлить подписки" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
