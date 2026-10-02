import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getRequiredEnv } from "@/lib/requireEnv";
import type { Locale } from "@/lib/i18nConfig";
import { errorLog, infoLog } from "@/lib/logger";

export const SUPPORT_CLIENT_KEY_RE = /^[a-zA-Z0-9_-]{8,128}$/;
export const SUPPORT_MAX_DELIVERY_ATTEMPTS = 6;
export const SUPPORT_DELIVERY_WINDOW_MS = 23 * 60 * 60 * 1000;

export function supportPayloadHash(topic: string, email: string, message: string): string {
  return createHash("sha256").update(`${topic}\n${email}\n${message}`).digest("hex");
}

export function getSupportInbox(): string {
  return getRequiredEnv("SUPPORT_INBOX_EMAIL");
}

export async function createOrReplaySupportTicket(params: {
  clientKey: string;
  topic: string;
  email: string;
  message: string;
  userId: string | null;
}): Promise<{ ticketId: string; replayed: boolean } | { conflict: true }> {
  const payloadHash = supportPayloadHash(params.topic, params.email, params.message);
  const existing = await prisma.supportTicket.findUnique({
    where: { clientKey: params.clientKey },
  });
  if (existing) {
    if (existing.payloadHash !== payloadHash) return { conflict: true };
    return { ticketId: existing.id, replayed: true };
  }

  try {
    const created = await prisma.supportTicket.create({
      data: {
        topic: params.topic,
        email: params.email,
        message: params.message,
        userId: params.userId,
        status: "open",
        clientKey: params.clientKey,
        payloadHash,
        deliveryStatus: "pending",
        nextAttemptAt: new Date(),
      },
    });
    return { ticketId: created.id, replayed: false };
  } catch (error) {
    const raced = await prisma.supportTicket.findUnique({
      where: { clientKey: params.clientKey },
    });
    if (raced && raced.payloadHash === payloadHash) {
      return { ticketId: raced.id, replayed: true };
    }
    if (raced) return { conflict: true };
    throw error;
  }
}

export async function claimSupportDeliveries(limit = 10, now = new Date()) {
  // Provider idempotency expires after 24h. Stop automatic retries before that window.
  await prisma.supportTicket.updateMany({
    where: { deliveryStatus: { in: ["pending", "failed"] },
      OR: [{ deliveryAttempts: { gte: SUPPORT_MAX_DELIVERY_ATTEMPTS } },
        { createdAt: { lt: new Date(now.getTime() - SUPPORT_DELIVERY_WINDOW_MS) } }] },
    data: { deliveryStatus: "dead", lastError: "retry_budget_exhausted", nextAttemptAt: null, claimedAt: null, claimToken: null },
  });
  await prisma.supportTicket.updateMany({
    where: {
      deliveryStatus: "sending",
      claimedAt: { lt: new Date(now.getTime() - 2 * 60 * 1000) },
    },
    data: {
      deliveryStatus: "failed",
      lastError: "stale_claim",
      nextAttemptAt: now,
      claimedAt: null,
      claimToken: null,
    },
  });

  const due = await prisma.supportTicket.findMany({
    where: {
      deliveryStatus: { in: ["pending", "failed"] },
      deliveryAttempts: { lt: SUPPORT_MAX_DELIVERY_ATTEMPTS },
      createdAt: { gte: new Date(now.getTime() - SUPPORT_DELIVERY_WINDOW_MS) },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const claimed = [];
  for (const row of due) {
    const token = randomUUID();
    const updated = await prisma.supportTicket.updateMany({
      where: {
        id: row.id,
        deliveryStatus: { in: ["pending", "failed"] },
        deliveryAttempts: row.deliveryAttempts,
      },
      data: {
        deliveryStatus: "sending",
        claimedAt: now,
        claimToken: token,
        deliveryAttempts: { increment: 1 },
      },
    });
    if (updated.count === 1) {
      claimed.push({ ...row, claimToken: token, deliveryAttempts: row.deliveryAttempts + 1 });
    }
  }
  return claimed;
}

export async function deliverSupportTicket(
  ticket: {
    id: string;
    topic: string;
    email: string;
    message: string;
    claimToken: string | null;
    deliveryAttempts: number;
    createdAt?: Date;
  },
  send?: (payload: {
    inbox: string;
    topicLabel: string;
    replyTo: string;
    message: string;
    ticketId: string;
    locale: Locale;
    idempotencyKey: string;
  }) => Promise<unknown>,
  locale: Locale = "ru"
): Promise<"sent" | "retry" | "dead" | "superseded"> {
  if (!ticket.claimToken) return "superseded";
  try {
    const inbox = getSupportInbox();
    const deliver =
      send ?? (await import("@/lib/email")).sendSupportTicketEmail;
    await deliver({
      inbox,
      topicLabel: ticket.topic,
      replyTo: ticket.email,
      message: ticket.message,
      ticketId: ticket.id,
      locale,
      idempotencyKey: `support/${ticket.id}`,
    });
    const saved = await prisma.supportTicket.updateMany({
      where: { id: ticket.id, claimToken: ticket.claimToken ?? undefined, deliveryStatus: "sending" },
      data: { deliveryStatus: "sent", lastError: null, claimedAt: null, claimToken: null },
    });
    return saved.count === 1 ? "sent" : "superseded";
  } catch {
    const exhausted = ticket.deliveryAttempts >= SUPPORT_MAX_DELIVERY_ATTEMPTS
      || (ticket.createdAt != null && Date.now() - ticket.createdAt.getTime() >= SUPPORT_DELIVERY_WINDOW_MS);
    const backoffMs = Math.min(30 * 60 * 1000, 15_000 * 2 ** Math.min(ticket.deliveryAttempts, 6));
    const saved = await prisma.supportTicket.updateMany({
      where: { id: ticket.id, claimToken: ticket.claimToken ?? undefined, deliveryStatus: "sending" },
      data: {
        deliveryStatus: exhausted ? "dead" : "failed",
        lastError: "delivery_failed",
        nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffMs),
        claimedAt: null,
        claimToken: null,
      },
    });
    if (!saved.count) return "superseded";
    errorLog("Support", exhausted ? "delivery needs operator review" : "delivery failed", { ticketId: ticket.id });
    return exhausted ? "dead" : "retry";
  }
}

export async function processSupportOutbox(limit = 2) {
  const claimedRows = await claimSupportDeliveries(limit);
  let sent = 0;
  let retry = 0;
  let dead = 0;
  let superseded = 0;
  for (const row of claimedRows) {
    const result = await deliverSupportTicket(row);
    if (result === "sent") sent += 1;
    else if (result === "retry") retry += 1;
    else if (result === "dead") dead += 1;
    else superseded += 1;
  }
  if (claimedRows.length) {
    infoLog("Support", "outbox processed", { claimed: claimedRows.length, sent, retry });
  }
  const needsReview = await prisma.supportTicket.findMany({ where: { deliveryStatus: { in: ["dead", "manual_review"] } }, select: { id: true }, take: 20 });
  return { claimed: claimedRows.length, sent, retry, dead, superseded, requiresAttention: needsReview.length > 0,
    reviewTicketIds: needsReview.map(row => row.id) };
}
