import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { anonymousExpiryFrom, isAnonymousExpired } from "@/lib/anonymousCookie";
import {
  canFinalizeAttempt,
  canRefundOnce,
  decideGuestClaim,
  guestPayloadHash,
  leaseFrom,
  messagesEligibleForTransfer,
  normalizeGuestMessage,
  type ClaimDecision,
  type GuestRequestSnapshot,
} from "@/lib/guestRequestPolicy";

const SchemaMissing = class SchemaMissingError extends Error {
  constructor() {
    super("Guest chat schema is not migrated");
    this.name = "SchemaMissingError";
  }
};

export class GuestSchemaMissingError extends SchemaMissing {}

function asSnapshot(row: {
  requestId: string;
  sessionId: string;
  characterId: string;
  payloadHash: string;
  status: string;
  attempt: number;
  leaseUntil: Date | null;
  reservedQuota: boolean;
  refundedAt: Date | null;
  userContent: string;
  assistantContent: string | null;
  userMessageId: string | null;
  assistantMessageId: string | null;
  remainingMessages: number | null;
}): GuestRequestSnapshot {
  return {
    ...row,
    status: row.status as GuestRequestSnapshot["status"],
  };
}

export async function assertGuestSchemaReady(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "AnonymousChatRequest" LIMIT 1`;
  } catch {
    throw new GuestSchemaMissingError();
  }
}

// All guest state transitions acquire the session row before request rows.
// The lock lasts only for the short DB transaction, never for an AI call.
export async function lockGuestSession(tx: Prisma.TransactionClient, sessionId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ sessionId: string }>>`
    SELECT "sessionId" FROM "AnonymousSession" WHERE "sessionId" = ${sessionId} FOR UPDATE
  `;
  return rows.length > 0;
}

export async function refundGuestRequestOnce(
  tx: Prisma.TransactionClient,
  request: Pick<GuestRequestSnapshot, "sessionId" | "requestId" | "attempt" | "reservedQuota" | "refundedAt">
): Promise<boolean> {
  if (!canRefundOnce(request)) return false;
  const marked = await tx.anonymousChatRequest.updateMany({
    where: {
      sessionId: request.sessionId, requestId: request.requestId, attempt: request.attempt,
      status: "failed", refundedAt: null, reservedQuota: true,
    },
    data: { refundedAt: new Date() },
  });
  if (marked.count === 0) return false;
  await tx.anonymousSession.updateMany({
    where: { sessionId: request.sessionId, messagesCount: { gt: 0 } },
    data: { messagesCount: { decrement: 1 } },
  });
  return true;
}

export type ClaimResult =
  | Extract<ClaimDecision, { kind: "revoked" | "expired" | "conflict" | "replay" | "in_progress" | "quota" }>
  | {
      kind: "run";
      mode: "create" | "retry";
      attempt: number;
      remaining: number;
      userMessageId: string | null;
      request: GuestRequestSnapshot;
    };

export async function claimGuestGeneration(params: {
  sessionId: string;
  requestId: string;
  characterId: string;
  message: string;
  quotaLimit: number;
  now?: Date;
}): Promise<ClaimResult> {
  const now = params.now ?? new Date();
  const payloadHash = guestPayloadHash(params.characterId, params.message);

  return prisma.$transaction(async (tx) => {
    await tx.anonymousSession.createMany({
      data: [{ sessionId: params.sessionId, expiresAt: anonymousExpiryFrom(now) }],
      skipDuplicates: true,
    });
    await lockGuestSession(tx, params.sessionId);
    await recoverExpiredGuestGenerations(tx, params.sessionId, now);
    const session = await tx.anonymousSession.findUniqueOrThrow({ where: { sessionId: params.sessionId } });

    const existingRow = await tx.anonymousChatRequest.findUnique({
      where: { sessionId_requestId: { sessionId: params.sessionId, requestId: params.requestId } },
    });
    const existing = existingRow ? asSnapshot(existingRow) : null;
    const decision = decideGuestClaim({
      session: {
        sessionId: session.sessionId,
        messagesCount: session.messagesCount,
        transferredToUserId: session.transferredToUserId,
        expired: isAnonymousExpired(session.expiresAt, session.createdAt, now),
      },
      existing,
      characterId: params.characterId,
      payloadHash,
      now,
      quotaLimit: params.quotaLimit,
    });

    if (decision.kind !== "run") {
      return decision;
    }

    if (decision.consumeQuota) {
      const claimed = await tx.anonymousSession.updateMany({
        where: {
          sessionId: params.sessionId,
          messagesCount: { lt: params.quotaLimit },
          transferredToUserId: null,
        },
        data: { messagesCount: { increment: 1 }, expiresAt: anonymousExpiryFrom(now) },
      });
      if (claimed.count === 0) {
        return { kind: "quota" as const };
      }
    }

    const next = await tx.anonymousSession.findUnique({
      where: { sessionId: params.sessionId },
      select: { messagesCount: true },
    });
    const remaining = Math.max(0, params.quotaLimit - (next?.messagesCount ?? params.quotaLimit));

    if (decision.mode === "create") {
      const created = await tx.anonymousChatRequest.create({
        data: {
          requestId: params.requestId,
          sessionId: params.sessionId,
          characterId: params.characterId,
          payloadHash,
          status: "pending",
          attempt: 1,
          leaseUntil: leaseFrom(now),
          reservedQuota: true,
          userContent: params.message,
          remainingMessages: remaining,
        },
      });
      return {
        kind: "run" as const,
        mode: "create" as const,
        attempt: 1,
        remaining,
        userMessageId: null,
        request: asSnapshot(created),
      };
    }

    const fenced = await tx.anonymousChatRequest.updateMany({
      where: {
        sessionId: params.sessionId,
        requestId: params.requestId,
        attempt: existing?.attempt,
        OR: [{ status: "failed" }, { status: "pending", leaseUntil: { lt: now } }],
      },
      data: {
        status: "pending",
        attempt: decision.nextAttempt,
        leaseUntil: leaseFrom(now),
        reservedQuota: true,
        refundedAt: decision.consumeQuota ? null : existing?.refundedAt,
        assistantContent: null,
        assistantMessageId: null,
      },
    });
    if (fenced.count === 0) {
      if (decision.consumeQuota) {
        await tx.anonymousSession.update({
          where: { sessionId: params.sessionId }, data: { messagesCount: { decrement: 1 } },
        });
      }
      return existing ? { kind: "in_progress" as const, request: existing } : { kind: "quota" as const };
    }
    const updated = await tx.anonymousChatRequest.findUniqueOrThrow({
      where: { sessionId_requestId: { sessionId: params.sessionId, requestId: params.requestId } },
    });
    return {
      kind: "run" as const,
      mode: "retry" as const,
      attempt: decision.nextAttempt,
      remaining,
      userMessageId: decision.existingUserMessageId,
      request: asSnapshot(updated),
    };
  });
}

export async function failGuestGeneration(params: {
  sessionId: string;
  requestId: string;
  attempt: number;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (!(await lockGuestSession(tx, params.sessionId))) return;
    const row = await tx.anonymousChatRequest.findUnique({
      where: { sessionId_requestId: { sessionId: params.sessionId, requestId: params.requestId } },
    });
    if (!row || !canFinalizeAttempt(asSnapshot(row), params.attempt)) return;
    const marked = await tx.anonymousChatRequest.updateMany({
      where: {
        sessionId: params.sessionId,
        requestId: params.requestId,
        attempt: params.attempt,
        status: "pending",
      },
      data: { status: "failed" },
    });
    if (marked.count === 1) await refundGuestRequestOnce(tx, asSnapshot(row));
  });
}

export async function finalizeGuestGeneration(params: {
  sessionId: string;
  requestId: string;
  attempt: number;
  characterId: string;
  assistantContent: string;
  userMessageId: string;
  remainingMessages: number;
}): Promise<{ assistantMessageId: string } | null> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockGuestSession(tx, params.sessionId))) return null;
    const row = await tx.anonymousChatRequest.findUnique({
      where: { sessionId_requestId: { sessionId: params.sessionId, requestId: params.requestId } },
    });
    if (!row || !canFinalizeAttempt(asSnapshot(row), params.attempt)) {
      return null;
    }
    const assistant = await tx.anonymousMessage.create({
      data: {
        sessionId: params.sessionId,
        characterId: params.characterId,
        role: "assistant",
        content: params.assistantContent,
        requestId: params.requestId,
      },
    });
    const updated = await tx.anonymousChatRequest.updateMany({
      where: {
        sessionId: params.sessionId,
        requestId: params.requestId,
        attempt: params.attempt,
        status: "pending",
      },
      data: {
        status: "completed",
        assistantContent: params.assistantContent,
        userMessageId: params.userMessageId,
        assistantMessageId: assistant.id,
        remainingMessages: params.remainingMessages,
      },
    });
    if (updated.count === 0) {
      await tx.anonymousMessage.delete({ where: { id: assistant.id } });
      return null;
    }
    return { assistantMessageId: assistant.id };
  });
}

export async function persistGuestUserMessage(params: {
  sessionId: string; requestId: string; attempt: number; characterId: string; message: string;
}): Promise<{ id: string; createdAt: Date } | null> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockGuestSession(tx, params.sessionId))) return null;
    const row = await tx.anonymousChatRequest.findUnique({
      where: { sessionId_requestId: { sessionId: params.sessionId, requestId: params.requestId } },
    });
    if (!row || !canFinalizeAttempt(asSnapshot(row), params.attempt)) return null;
    if (row.userMessageId) {
      return tx.anonymousMessage.findUniqueOrThrow({
        where: { id: row.userMessageId }, select: { id: true, createdAt: true },
      });
    }
    const message = await tx.anonymousMessage.create({
      data: { sessionId: params.sessionId, requestId: params.requestId,
        characterId: params.characterId, role: "user", content: params.message },
      select: { id: true, createdAt: true },
    });
    await tx.anonymousChatRequest.update({ where: { id: row.id }, data: { userMessageId: message.id } });
    return message;
  });
}

export async function recoverExpiredGuestGenerations(
  tx: Prisma.TransactionClient, sessionId: string, now = new Date()
): Promise<number> {
  // Caller holds the session lock; every refund is fenced to its attempt.
  const rows = await tx.anonymousChatRequest.findMany({
    where: { sessionId, status: "pending", OR: [{ leaseUntil: { lte: now } }, { leaseUntil: null }] },
  });
  let recovered = 0;
  for (const row of rows) {
    const marked = await tx.anonymousChatRequest.updateMany({
      where: { id: row.id, status: "pending", attempt: row.attempt }, data: { status: "failed" },
    });
    if (marked.count !== 1) continue;
    await refundGuestRequestOnce(tx, asSnapshot(row));
    recovered += 1;
  }
  return recovered;
}

export async function recoverGuestSession(sessionId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (await lockGuestSession(tx, sessionId)) await recoverExpiredGuestGenerations(tx, sessionId);
  });
}

export async function renewGuestGeneration(params: {
  sessionId: string; requestId: string; attempt: number;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockGuestSession(tx, params.sessionId))) return false;
    const now = new Date();
    const updated = await tx.anonymousChatRequest.updateMany({
      where: { sessionId: params.sessionId, requestId: params.requestId, attempt: params.attempt,
        status: "pending", leaseUntil: { gt: now }, session: { transferredToUserId: null } },
      data: { leaseUntil: leaseFrom(now) },
    });
    return updated.count === 1;
  });
}

export { normalizeGuestMessage, messagesEligibleForTransfer, guestPayloadHash };
