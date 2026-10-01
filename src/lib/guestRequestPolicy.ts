import { createHash } from "node:crypto";

export const GUEST_LEASE_MS = 60_000;
export const MAX_GUEST_MESSAGE_CHARS = 4_000;
export const MAX_ANONYMOUS_HISTORY = 8;

export type GuestRequestStatus = "pending" | "completed" | "failed";

export type GuestRequestSnapshot = {
  requestId: string;
  sessionId: string;
  characterId: string;
  payloadHash: string;
  status: GuestRequestStatus;
  attempt: number;
  leaseUntil: Date | null;
  reservedQuota: boolean;
  refundedAt: Date | null;
  userContent: string;
  assistantContent: string | null;
  userMessageId: string | null;
  assistantMessageId: string | null;
  remainingMessages: number | null;
};

export type GuestSessionSnapshot = {
  sessionId: string;
  messagesCount: number;
  transferredToUserId: string | null;
  expired: boolean;
};

export type ClaimDecision =
  | { kind: "revoked" }
  | { kind: "expired" }
  | { kind: "conflict"; reason: "character" | "payload" }
  | { kind: "replay"; request: GuestRequestSnapshot }
  | { kind: "in_progress"; request: GuestRequestSnapshot }
  | { kind: "quota" }
  | {
      kind: "run";
      mode: "create" | "retry";
      consumeQuota: boolean;
      nextAttempt: number;
      existingUserMessageId: string | null;
    };

export function normalizeGuestMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_GUEST_MESSAGE_CHARS) return null;
  return trimmed;
}

export function guestPayloadHash(characterId: string, message: string): string {
  return createHash("sha256").update(`${characterId}\n${message}`).digest("hex");
}

export function leaseFrom(now: Date, ms = GUEST_LEASE_MS): Date {
  return new Date(now.getTime() + ms);
}

export function isLeaseActive(leaseUntil: Date | null | undefined, now: Date): boolean {
  if (!leaseUntil) return false;
  return leaseUntil.getTime() > now.getTime();
}

export function decideGuestClaim(params: {
  session: GuestSessionSnapshot;
  existing: GuestRequestSnapshot | null;
  characterId: string;
  payloadHash: string;
  now: Date;
  quotaLimit: number;
}): ClaimDecision {
  if (params.session.transferredToUserId) return { kind: "revoked" };
  if (params.session.expired) return { kind: "expired" };

  const existing = params.existing;
  if (!existing) {
    if (params.session.messagesCount >= params.quotaLimit) return { kind: "quota" };
    return {
      kind: "run",
      mode: "create",
      consumeQuota: true,
      nextAttempt: 1,
      existingUserMessageId: null,
    };
  }

  if (existing.characterId !== params.characterId) return { kind: "conflict", reason: "character" };
  if (existing.payloadHash !== params.payloadHash) return { kind: "conflict", reason: "payload" };

  if (existing.status === "completed" && existing.assistantContent) {
    return { kind: "replay", request: existing };
  }

  if (existing.status === "pending" && isLeaseActive(existing.leaseUntil, params.now)) {
    return { kind: "in_progress", request: existing };
  }

  const needsQuota = Boolean(existing.refundedAt) || !existing.reservedQuota;
  if (needsQuota && params.session.messagesCount >= params.quotaLimit) {
    return { kind: "quota" };
  }

  return {
    kind: "run",
    mode: "retry",
    consumeQuota: needsQuota,
    nextAttempt: existing.attempt + 1,
    existingUserMessageId: existing.userMessageId,
  };
}

export function canFinalizeAttempt(
  existing: Pick<GuestRequestSnapshot, "status" | "attempt">,
  attempt: number
): boolean {
  return existing.status === "pending" && existing.attempt === attempt;
}

export function canRefundOnce(existing: Pick<GuestRequestSnapshot, "reservedQuota" | "refundedAt">): boolean {
  return existing.reservedQuota && !existing.refundedAt;
}

export function messagesEligibleForTransfer(
  messages: Array<{ id: string; requestId: string | null; role: string }>,
  requests: Array<{ requestId: string; status: GuestRequestStatus }>
): string[] {
  const byRequest = new Map(requests.map((item) => [item.requestId, item.status]));
  const ids: string[] = [];
  for (const message of messages) {
    if (!message.requestId) continue;
    if (byRequest.get(message.requestId) === "completed") {
      ids.push(message.id);
    }
  }
  return ids;
}
