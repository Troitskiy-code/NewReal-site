import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureAnonymousChatTables } from "@/lib/ensureAnonymousChatTables";
import { errorLog, infoLog } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 30;

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
  if (querySecret) return querySecret;
  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) return cronHeader;
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return "";
}

async function handle(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const provided = getProvidedSecret(req);

  infoLog("Cron:CleanupAnonymous", `CRON_SECRET=${maskSecret(expected)}`);
  infoLog("Cron:CleanupAnonymous", `provided secret=${maskSecret(provided)}`);

  if (!expected) {
    errorLog("Cron:CleanupAnonymous", "CRON_SECRET not configured");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  if (provided !== expected) {
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
    errorLog("Cron:CleanupAnonymous", "cleanup failed", error);
    return NextResponse.json({ error: "Cleanup failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
