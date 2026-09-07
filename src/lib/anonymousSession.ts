import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  ANONYMOUS_LIMIT_CODE,
  ANONYMOUS_LIMIT_MESSAGE,
  ANONYMOUS_SESSION_COOKIE,
  createAnonymousSessionId,
  isValidAnonymousSessionId,
} from "@/lib/anonymousCookie";

const ANONYMOUS_LIMIT = (() => {
  const parsed = parseInt(process.env.ANONYMOUS_MESSAGE_LIMIT || "5", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
})();

export function getAnonymousMessageLimit(): number {
  return ANONYMOUS_LIMIT;
}

export { ANONYMOUS_LIMIT_CODE, ANONYMOUS_LIMIT_MESSAGE };

export function readAnonymousSessionId(req: NextRequest): string | null {
  const value = req.cookies.get(ANONYMOUS_SESSION_COOKIE)?.value?.trim() ?? "";
  return isValidAnonymousSessionId(value) ? value : null;
}

export function attachAnonymousSessionCookie(response: NextResponse, sessionId: string): NextResponse {
  response.cookies.set(ANONYMOUS_SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}

export function resolveAnonymousSessionId(req: NextRequest): { sessionId: string; isNew: boolean } {
  const existing = readAnonymousSessionId(req);
  if (existing) {
    return { sessionId: existing, isNew: false };
  }
  return { sessionId: createAnonymousSessionId(), isNew: true };
}

export async function ensureAnonymousSession(sessionId: string) {
  const existing = await prisma.anonymousSession.findUnique({
    where: { sessionId },
    select: { id: true, sessionId: true, messagesCount: true },
  });
  if (existing) {
    return existing;
  }

  const created = await prisma.anonymousSession.create({
    data: { sessionId },
    select: { id: true, sessionId: true, messagesCount: true },
  });
  console.log(`[Anonymous] Created session sessionId=${sessionId.slice(0, 8)}...`);
  return created;
}

export async function getAnonymousRemaining(sessionId: string): Promise<number> {
  const row = await ensureAnonymousSession(sessionId);
  return Math.max(0, ANONYMOUS_LIMIT - row.messagesCount);
}

export async function consumeAnonymousMessage(
  sessionId: string
): Promise<{ ok: true; remaining: number; count: number } | { ok: false; remaining: 0 }> {
  await ensureAnonymousSession(sessionId);

  const claimed = await prisma.anonymousSession.updateMany({
    where: { sessionId, messagesCount: { lt: ANONYMOUS_LIMIT } },
    data: { messagesCount: { increment: 1 } },
  });

  if (claimed.count === 0) {
    console.log(`[Anonymous] Limit exceeded sessionId=${sessionId.slice(0, 8)}...`);
    return { ok: false, remaining: 0 };
  }

  const row = await prisma.anonymousSession.findUnique({
    where: { sessionId },
    select: { messagesCount: true },
  });
  const count = row?.messagesCount ?? ANONYMOUS_LIMIT;
  const remaining = Math.max(0, ANONYMOUS_LIMIT - count);
  console.log(
    `[Anonymous] Message used sessionId=${sessionId.slice(0, 8)}... count=${count} remaining=${remaining}`
  );
  return { ok: true, remaining, count };
}

export async function refundAnonymousMessage(sessionId: string): Promise<void> {
  await prisma.anonymousSession.updateMany({
    where: { sessionId, messagesCount: { gt: 0 } },
    data: { messagesCount: { decrement: 1 } },
  });
  console.log(`[Anonymous] Refunded message sessionId=${sessionId.slice(0, 8)}...`);
}
