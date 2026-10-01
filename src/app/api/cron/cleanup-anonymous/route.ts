import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureAnonymousChatTables } from "@/lib/ensureAnonymousChatTables";
import { errorLog, infoLog, toSafeDiagnostic } from "@/lib/logger";
import { getCronProvidedSecret, logCronSecretCheck } from "@/lib/cronAuth";

export const runtime = "nodejs";
export const maxDuration = 30;

async function handle(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = getCronProvidedSecret(req);
  const check = logCronSecretCheck("Cron:CleanupAnonymous", expected, provided);

  if (!check.configured) {
    errorLog("Cron:CleanupAnonymous", "CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  if (!check.matched) {
    return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
  }

  try {
    await ensureAnonymousChatTables();
    const cutoff = new Date();
    const expiredSessions = await prisma.anonymousSession.findMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { expiresAt: null, createdAt: { lt: new Date(cutoff.getTime() - 7 * 24 * 60 * 60 * 1000) } }] },
      select: { sessionId: true },
    });
    const sessionIds = expiredSessions.map((row) => row.sessionId);
    const messages = sessionIds.length
      ? await prisma.anonymousMessage.deleteMany({ where: { sessionId: { in: sessionIds } } })
      : { count: 0 };
    const requests = sessionIds.length
      ? await prisma.anonymousChatRequest.deleteMany({ where: { sessionId: { in: sessionIds } } })
      : { count: 0 };
    const sessions = sessionIds.length
      ? await prisma.anonymousSession.deleteMany({ where: { sessionId: { in: sessionIds } } })
      : { count: 0 };

    infoLog("Cron:CleanupAnonymous", `removed sessions=${sessions.count} messages=${messages.count} requests=${requests.count}`);
    return NextResponse.json({
      ok: true,
      sessions: sessions.count,
      messages: messages.count,
      requests: requests.count,
    });
  } catch (error) {
    errorLog("Cron:CleanupAnonymous", "cleanup failed", toSafeDiagnostic(error));
    return NextResponse.json({ error: "Cleanup failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
