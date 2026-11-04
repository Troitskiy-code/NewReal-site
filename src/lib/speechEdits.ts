import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { messageScopeWhere, type ChatScope } from "./chatThreads";
import { ChatSpeechError } from "./chatSpeech";

export async function readSpeechEdit(req: NextRequest): Promise<Record<string, unknown>> {
  const origin = req.headers.get("origin");
  const allowed = new Set([new URL(req.url).origin]);
  if (process.env.NEXTAUTH_URL) allowed.add(new URL(process.env.NEXTAUTH_URL).origin);
  if (req.headers.get("sec-fetch-site") === "cross-site" || (origin && !allowed.has(origin))) throw new ChatSpeechError("forbidden", 403);
  if (!req.headers.get("content-type")?.includes("application/json")) throw new ChatSpeechError("invalid", 400);
  const reader = req.body?.getReader();
  if (!reader) throw new ChatSpeechError("invalid", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new ChatSpeechError("invalid", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ChatSpeechError("invalid", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChatSpeechError("invalid", 400);
  return body as Record<string, unknown>;
}

/** Caller holds the user row lock, also used by synthesis reservations. Unpaid abandoned preparation is editable. */
export async function assertSpeechEditable(tx: Prisma.TransactionClient, scope: ChatScope, messageId?: string) {
  const now = new Date();
  if (await tx.speechClip.findFirst({ where: { userId: scope.userId, expiresAt: { gt: now },
    message: { ...messageScopeWhere(scope), ...(messageId ? { id: messageId } : {}) },
    OR: [{ status: "processing", leaseUntil: { gt: now } },
      { status: { in: ["pending", "processing"] }, OR: [{ providerTaskId: { not: null } }, { costEventId: { not: null } }] }] },
    select: { id: true } })) throw new ChatSpeechError("busy", 409);
}
