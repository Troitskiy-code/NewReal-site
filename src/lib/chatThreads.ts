import { prisma } from "@/lib/prisma";
import type { ChatThread, Prisma } from "@prisma/client";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";
import { THREAD_QUERY_PARAM, type ChatThreadStatus, type ChatThreadSummary } from "@/lib/chatThreadShared";

/**
 * Independent stories with one character. With the flag off (default) every user+character pair
 * has exactly one story, and message reads also include rows the batched backfill has not
 * assigned yet, so the previous behaviour is kept without rolling the schema back.
 */
export function chatThreadsEnabled(): boolean {
  return ["1", "true"].includes((process.env['CHAT_THREADS_ENABLED'] ?? "").trim().toLowerCase());
}

export { THREAD_QUERY_PARAM, type ChatThreadStatus, type ChatThreadSummary } from "@/lib/chatThreadShared";
export const THREAD_TITLE_MAX_LENGTH = 80;
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ChatScope = {
  userId: string;
  characterId: string;
  threadId: string;
  /** Flag off: the only story of the pair; unassigned legacy message rows belong to it. */
  legacy: boolean;
};

export type ScopeResolution =
  | { status: "found"; scope: ChatScope; thread: ChatThread }
  /** No story exists yet and the caller did not ask to create one. */
  | { status: "none"; legacy: boolean }
  /** The requested story is malformed, deleted, foreign or belongs to another character. */
  | { status: "not_found" };

type ThreadClient = Prisma.TransactionClient | typeof prisma;

export function requestedThreadId(req: { nextUrl?: URL; url?: string }): string | null {
  const url = req.nextUrl ?? (req.url ? new URL(req.url) : null);
  return url?.searchParams.get(THREAD_QUERY_PARAM) ?? null;
}

export function isValidThreadId(value: unknown): value is string {
  return typeof value === "string" && THREAD_ID_PATTERN.test(value);
}

export function threadStatus(value: string): ChatThreadStatus {
  return value === "archived" ? "archived" : "active";
}

export function toThreadSummary(thread: Pick<ChatThread, "id" | "number" | "title" | "status" | "createdAt" | "lastMessageAt">, messageCount?: number): ChatThreadSummary {
  return {
    id: thread.id,
    number: thread.number,
    title: thread.title,
    status: threadStatus(thread.status),
    createdAt: thread.createdAt.toISOString(),
    lastMessageAt: thread.lastMessageAt.toISOString(),
    ...(typeof messageCount === "number" ? { messageCount } : {}),
  };
}

/** Message rows of a story. Legacy mode also reads rows not yet assigned by the backfill. */
export function messageScopeWhere(scope: ChatScope): Prisma.MessageWhereInput {
  const { userId, characterId, threadId } = scope;
  return scope.legacy
    ? { userId, characterId, OR: [{ threadId }, { threadId: null }] }
    : { userId, characterId, threadId };
}

/** Memory rows are assigned by the migration itself, so they are always read strictly by story. */
export function memoryScopeWhere(scope: ChatScope) {
  return { userId: scope.userId, characterId: scope.characterId, threadId: scope.threadId };
}

export function threadPromptScopeKey(threadId: string): string {
  return `thread:${threadId}`;
}

/** null = automatic title; undefined = invalid input. */
export function normalizeThreadTitle(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > THREAD_TITLE_MAX_LENGTH ? undefined : cleaned;
}

/** Same rule as the migration/backfill: the most recent story. Flag on: only active ones open by default. */
export async function findDefaultThread(userId: string, characterId: string, legacy = !chatThreadsEnabled(), client: ThreadClient = prisma) {
  return client.chatThread.findFirst({
    where: { userId, characterId, ...(legacy ? {} : { status: "active" }) },
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
}

/** Serializes story creation for one user+character, so numbers and the legacy single story stay unique. */
async function lockPair(tx: Prisma.TransactionClient, userId: string, characterId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat-thread:${userId}:${characterId}`}))`;
}

export async function createThreadInTransaction(tx: Prisma.TransactionClient, data: {
  userId: string;
  characterId: string;
  title?: string | null;
  personaId?: string | null;
  /** Copy the persona of this story (same owner and character); otherwise the pair's last choice. */
  sourceThreadId?: string | null;
  lastMessageAt?: Date;
}): Promise<ChatThread> {
  await lockPair(tx, data.userId, data.characterId);
  const last = await tx.chatThread.aggregate({
    where: { userId: data.userId, characterId: data.characterId },
    _max: { number: true },
  });
  let personaId = data.personaId;
  if (personaId === undefined && data.sourceThreadId) {
    const source = await tx.chatThread.findFirst({
      where: { id: data.sourceThreadId, userId: data.userId, characterId: data.characterId },
      select: { personaId: true },
    });
    if (source) personaId = source.personaId;
  }
  if (personaId === undefined) {
    const selection = await tx.personaSelection.findUnique({
      where: { userId_characterId: { userId: data.userId, characterId: data.characterId } },
      select: { personaId: true, persona: { select: { userId: true } } },
    });
    personaId = selection?.persona.userId === data.userId ? selection.personaId : null;
  }
  const now = new Date();
  return tx.chatThread.create({
    data: {
      userId: data.userId,
      characterId: data.characterId,
      personaId,
      title: data.title ?? null,
      number: (last._max.number ?? 0) + 1,
      lastMessageAt: data.lastMessageAt ?? now,
    },
  });
}

export async function createChatThread(data: Parameters<typeof createThreadInTransaction>[1]): Promise<ChatThread> {
  return prisma.$transaction((tx) => createThreadInTransaction(tx, data));
}

/** Returns the default story, creating it under the pair lock if none qualifies. */
export async function ensureDefaultThread(userId: string, characterId: string, legacy = !chatThreadsEnabled()): Promise<ChatThread> {
  return prisma.$transaction(async (tx) => {
    await lockPair(tx, userId, characterId);
    const existing = await findDefaultThread(userId, characterId, legacy, tx);
    return existing ?? createThreadInTransaction(tx, { userId, characterId });
  });
}

export function scopeFor(thread: ChatThread, legacy = !chatThreadsEnabled()): ChatScope {
  return { userId: thread.userId, characterId: thread.characterId, threadId: thread.id, legacy };
}

/**
 * Resolves the story of a request. The caller has already authorized the character.
 * Flag off: the requested id is ignored and the pair's single story is used.
 */
export async function resolveChatScope(
  userId: string,
  characterId: string,
  requested: string | null | undefined,
  options: { create?: boolean } = {}
): Promise<ScopeResolution> {
  const legacy = !chatThreadsEnabled();
  if (!legacy && requested !== null && requested !== undefined) {
    if (!isValidThreadId(requested)) return { status: "not_found" };
    const thread = await prisma.chatThread.findFirst({ where: { id: requested, userId, characterId } });
    return thread ? { status: "found", scope: scopeFor(thread, legacy), thread } : { status: "not_found" };
  }
  const existing = await findDefaultThread(userId, characterId, legacy);
  if (existing) return { status: "found", scope: scopeFor(existing, legacy), thread: existing };
  if (!options.create) return { status: "none", legacy };
  const created = await ensureDefaultThread(userId, characterId, legacy);
  return { status: "found", scope: scopeFor(created, legacy), thread: created };
}

/** A new message makes the story the latest one and brings an archived story back. */
export function touchThread(threadId: string, at = new Date()) {
  return prisma.chatThread.update({ where: { id: threadId }, data: { lastMessageAt: at, status: "active" } });
}

/** After an already stored reply: activity is best effort and must never undo the stored result. */
export async function markThreadActive(threadId: string) {
  try {
    await touchThread(threadId);
  } catch (error) {
    errorLog("ChatThreads", "story activity update failed", toSafeDiagnostic(error));
  }
}
