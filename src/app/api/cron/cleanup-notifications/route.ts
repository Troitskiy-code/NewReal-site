import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureNotificationTable } from "@/lib/ensureNotificationTable";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { getCronProvidedSecret, logCronSecretCheck } from "@/lib/cronAuth";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getRetentionDays(): number {
  const parsed = Number.parseInt(process.env['NOTIFICATION_RETENTION_DAYS'] ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_RETENTION_DAYS;
}

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = getCronProvidedSecret(req);
  const check = logCronSecretCheck("Cron:CleanupNotifications", expected, provided);

  if (!check.configured) {
    errorLog("Cron:CleanupNotifications", "CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  if (!check.matched) {
    errorLog("Cron:CleanupNotifications", "secret check mismatch");
    return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  }

  try {
    await ensureNotificationTable();
    const retentionDays = getRetentionDays();
    const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);
    const result = await prisma.notification.deleteMany({
      where: {
        createdAt: { lt: cutoff },
      },
    });

    infoLog(
      "Cron:CleanupNotifications",
      `Deleted ${result.count} notifications older than ${retentionDays} days`
    );
    return NextResponse.json({ ok: true, deleted: result.count });
  } catch (error) {
    errorLog("Cron:CleanupNotifications", "Cleanup failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Не удалось удалить старые уведомления" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
