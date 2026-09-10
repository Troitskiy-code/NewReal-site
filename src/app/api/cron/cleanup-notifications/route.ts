import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureNotificationTable } from "@/lib/ensureNotificationTable";
import { errorLog, infoLog } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

function getRetentionDays(): number {
  const parsed = Number.parseInt(process.env.NOTIFICATION_RETENTION_DAYS ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_RETENTION_DAYS;
}

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = getProvidedSecret(req);

  infoLog("Cron:CleanupNotifications", `CRON_SECRET=${maskSecret(expected)}`);
  infoLog("Cron:CleanupNotifications", `provided secret=${maskSecret(provided)}`);

  if (!expected) {
    errorLog("Cron:CleanupNotifications", "CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  if (provided !== expected) {
    errorLog(
      "Cron:CleanupNotifications",
      `Cron secret mismatch: expected ${maskSecret(expected)}, got ${maskSecret(provided)}`
    );
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
    errorLog("Cron:CleanupNotifications", "Cleanup failed", error);
    return NextResponse.json({ error: "Не удалось удалить старые уведомления" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
