import { NextRequest, NextResponse } from "next/server";
import { getCurrencyRates, isAccountingCurrencyRate } from "@/lib/currencyRates";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { getCronProvidedSecret, logCronSecretCheck } from "@/lib/cronAuth";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = getCronProvidedSecret(req);
  const check = logCronSecretCheck("Cron:UpdateCurrency", expected, provided);

  if (!check.configured) {
    errorLog("Cron:UpdateCurrency", "CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  if (!check.matched) {
    errorLog("Cron:UpdateCurrency", "secret check mismatch");
    return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  }

  try {
    const rates = await getCurrencyRates({ forceRefresh: true });
    if (!isAccountingCurrencyRate(rates)) {
      return NextResponse.json({ ok: false, error: "Не удалось получить актуальный курс ЦБ" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, ...rates });
  } catch (error) {
    errorLog("Cron:UpdateCurrency", "update failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось обновить курсы валют" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
