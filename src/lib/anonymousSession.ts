import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  ANONYMOUS_LIMIT_CODE,
  ANONYMOUS_LIMIT_MESSAGE,
  ANONYMOUS_SESSION_COOKIE,
  anonymousCookieOptions,
  anonymousExpiryFrom,
  createAnonymousSessionId,
  isAnonymousExpired,
  isValidAnonymousSessionId,
} from "@/lib/anonymousCookie";
import { assertGuestSchemaReady } from "@/lib/guestRequestStore";

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
  response.cookies.set(ANONYMOUS_SESSION_COOKIE, sessionId, anonymousCookieOptions());
  return response;
}

export function clearAnonymousSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set(ANONYMOUS_SESSION_COOKIE, "", anonymousCookieOptions({ maxAge: 0 }));
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
  await assertGuestSchemaReady();

  const existing = await prisma.anonymousSession.findUnique({
    where: { sessionId },
  });
  if (existing) {
    if (isAnonymousExpired(existing.expiresAt, existing.createdAt)) {
      return { ...existing, expired: true as const };
    }
    return { ...existing, expired: false as const };
  }

  await prisma.anonymousSession.createMany({
    data: [{ sessionId, expiresAt: anonymousExpiryFrom() }], skipDuplicates: true,
  });
  const created = await prisma.anonymousSession.findUniqueOrThrow({ where: { sessionId } });
  return { ...created, expired: isAnonymousExpired(created.expiresAt, created.createdAt) };
}

export async function getAnonymousRemaining(sessionId: string): Promise<number> {
  const row = await ensureAnonymousSession(sessionId);
  if (row.expired) return 0;
  return Math.max(0, ANONYMOUS_LIMIT - row.messagesCount);
}

export async function consumeAnonymousMessage(
  sessionId: string
): Promise<{ ok: true; remaining: number; count: number } | { ok: false; remaining: 0; expired?: boolean }> {
  const row = await ensureAnonymousSession(sessionId);
  if (row.expired) {
    return { ok: false, remaining: 0, expired: true };
  }

  const claimed = await prisma.anonymousSession.updateMany({
    where: { sessionId, messagesCount: { lt: ANONYMOUS_LIMIT } },
    data: {
      messagesCount: { increment: 1 },
      expiresAt: anonymousExpiryFrom(),
    },
  });

  if (claimed.count === 0) {
    console.log(`[Anonymous] Limit exceeded sessionId=${sessionId.slice(0, 8)}...`);
    return { ok: false, remaining: 0 };
  }

  const next = await prisma.anonymousSession.findUnique({
    where: { sessionId },
    select: { messagesCount: true },
  });
  const count = next?.messagesCount ?? ANONYMOUS_LIMIT;
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
}
