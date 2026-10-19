import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { moscowDayKey, nextMoscowMidnight } from "./freeDailyQuota";
import { getSubscriptionPlan } from "./chatEconomy";
import { speechText, SPEECH_MAX_CHARACTERS, type SpeechVoice, type SpeechQuota } from "./speech";
import { SPEECH_MODEL, SPEECH_CACHE_VERSION, speechEnabled } from "./speechProvider";

const LEASE_MS = 120_000;
const CACHE_MS = 7 * 86_400_000;
export class ChatSpeechError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}
type SpeechUser = { subscriptionType: string | null; subscriptionEnd: Date | null };
export function unlimitedSpeech(user: SpeechUser, now = new Date()): boolean {
  return getSubscriptionPlan(user.subscriptionType).monthlyPrice > 0
    && Boolean(user.subscriptionEnd && user.subscriptionEnd > now);
}

export function speechClipId(userId: string, messageId: string, text: string, voice: SpeechVoice): string {
  return createHash("sha256").update(JSON.stringify(["speech-dialogue-v2", SPEECH_CACHE_VERSION, SPEECH_MODEL, userId, messageId, text, voice])).digest("hex");
}
async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { subscriptionType: true, subscriptionEnd: true } });
  if (!user) throw new ChatSpeechError("unauthorized", 401);
  return user;
}

async function quota(tx: Prisma.TransactionClient, userId: string, user: SpeechUser, now: Date): Promise<SpeechQuota> {
  const unlimited = unlimitedSpeech(user, now);
  const daily = await tx.speechDailyQuota.findUnique({ where: { userId_day: { userId, day: moscowDayKey(now) } } });
  return { enabled: speechEnabled(), unlimited, remaining: unlimited ? null : Math.max(0, 1 - (daily?.used ?? 0)),
    resetsAt: nextMoscowMidnight(now).toISOString() };
}
export async function getSpeechQuota(userId: string, now = new Date()): Promise<SpeechQuota> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => quota(tx, userId, await lockUser(tx, userId), now));
}

async function debitPlayback(tx: Prisma.TransactionClient, userId: string, day: string) {
  const daily = await tx.speechDailyQuota.findUnique({ where: { userId_day: { userId, day } } });
  if ((daily?.used ?? 0) >= 1) throw new ChatSpeechError("quota", 429);
  await tx.speechDailyQuota.upsert({ where: { userId_day: { userId, day } },
    create: { userId, day, used: 1 }, update: { used: { increment: 1 } } });
}

type Source = { userId: string; characterId: string; messageId: string; voice: SpeechVoice };
export type SpeechReservation = Source & { id: string; token: string; text: string; freeDay: string | null;
  providerTaskId: string | null; costEventId: string; uncertain: boolean; startedAt: Date };
type Reserved = { kind: "cached"; audio: Buffer; quota: SpeechQuota } | { kind: "reserved"; reservation: SpeechReservation };

export async function reserveSpeech(source: Source, now = new Date()): Promise<Reserved> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const user = await lockUser(tx, source.userId);
    const message = await tx.message.findFirst({ where: { id: source.messageId, userId: source.userId,
      characterId: source.characterId, role: "assistant" }, select: { content: true } });
    if (!message) throw new ChatSpeechError("notFound", 404);
    const text = speechText(message.content);
    if (!text) throw new ChatSpeechError("empty", 400);
    if (Array.from(text).length > SPEECH_MAX_CHARACTERS) throw new ChatSpeechError("tooLong", 400);
    const id = speechClipId(source.userId, source.messageId, text, source.voice);
    const state = await quota(tx, source.userId, user, now);
    if (!state.unlimited && state.remaining === 0) throw new ChatSpeechError("quota", 429);
    // A cached play cannot spend the allowance while another paid synthesis is in flight.
    if (await tx.speechClip.findFirst({ where: { userId: source.userId, status: "processing", leaseUntil: { gt: now } }, select: { id: true } }))
      throw new ChatSpeechError("busy", 409);
    // A pending Kie task can be resumed for this reply; another reply cannot start alongside it.
    if (await tx.speechClip.findFirst({ where: { userId: source.userId, id: { not: id }, status: "pending",
      providerTaskId: { not: null }, updatedAt: { gt: new Date(now.getTime() - 30 * 60_000) } }, select: { id: true } }))
      throw new ChatSpeechError("busy", 409);
    const cached = await tx.speechClip.findUnique({ where: { id } });
    // A cache hit saves provider money, but still grants one new playback to this user.
    if (cached?.status === "ready" && cached.audio && cached.expiresAt > now) {
      if (!state.unlimited) await debitPlayback(tx, source.userId, moscowDayKey(now));
      await tx.speechClip.update({ where: { id }, data: { expiresAt: new Date(now.getTime() + CACHE_MS) } });
      return { kind: "cached", audio: Buffer.from(cached.audio), quota: await quota(tx, source.userId, user, now) };
    }

    // Both quota checks and leases share the user row lock.
    await tx.speechClip.deleteMany({ where: { userId: source.userId, OR: [
      { expiresAt: { lt: now } },
      { status: "processing", leaseUntil: { lte: now }, providerTaskId: null, costEventId: null },
    ] } });
    const token = randomUUID();
    const resume = cached && cached.status !== "ready" && cached.expiresAt > now && Boolean(cached.costEventId);
    const providerTaskId = resume ? cached.providerTaskId : null;
    const costEventId = resume ? cached.costEventId! : randomUUID();
    const startedAt = resume ? cached.createdAt : now;
    const data = { userId: source.userId, messageId: source.messageId, voice: source.voice, inputCharacters: Array.from(text).length,
      status: "processing", audio: null, requestToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS),
      providerTaskId, costEventId, createdAt: startedAt, expiresAt: new Date(now.getTime() + CACHE_MS) };
    await tx.speechClip.upsert({ where: { id }, create: { id, ...data }, update: data });
    return { kind: "reserved", reservation: { ...source, id, token, text, providerTaskId, costEventId, startedAt,
      uncertain: Boolean(resume && !providerTaskId), freeDay: state.unlimited ? null : moscowDayKey(now) } };
  });
}

export async function attachSpeechTask(job: SpeechReservation, taskId: string) {
  const result = await prisma.speechClip.updateMany({ where: { id: job.id, requestToken: job.token, status: "processing" },
    data: { providerTaskId: taskId } });
  if (!result.count) throw new ChatSpeechError("changed", 409);
  job.providerTaskId = taskId;
}
export async function deferSpeech(job: SpeechReservation) {
  await prisma.speechClip.updateMany({ where: { id: job.id, requestToken: job.token, status: "processing" },
    data: { status: "pending", requestToken: null, leaseUntil: null } });
}

export async function finishSpeech(job: SpeechReservation, audio: Buffer, now = new Date()): Promise<SpeechQuota> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const user = await lockUser(tx, job.userId);
    const clip = await tx.speechClip.findFirst({ where: { id: job.id, requestToken: job.token,
      status: "processing", leaseUntil: { gt: now } }, select: { id: true } });
    const message = await tx.message.findFirst({ where: { id: job.messageId, userId: job.userId,
      characterId: job.characterId, role: "assistant" }, select: { content: true } });
    if (!clip || !message || speechClipId(job.userId, job.messageId, speechText(message.content), job.voice) !== job.id)
      throw new ChatSpeechError("changed", 409);
    // A queued task can cross midnight or a subscription expiry. Charge the entitlement at delivery.
    if (!unlimitedSpeech(user, now)) await debitPlayback(tx, job.userId, moscowDayKey(now));
    await tx.speechClip.update({ where: { id: job.id }, data: { status: "ready", audio,
      requestToken: null, leaseUntil: null, expiresAt: new Date(now.getTime() + CACHE_MS) } });
    return quota(tx, job.userId, user, now);
  });
}

export async function failSpeech(job: SpeechReservation) {
  // The token prevents an expired request from deleting its replacement's reservation.
  await prisma.speechClip.deleteMany({ where: { id: job.id, requestToken: job.token, status: "processing" } });
}

/** Reuse the existing daily cleanup job; old audio must not grow the database indefinitely. */
export async function cleanupSpeechCache(now = new Date()) {
  // Indexed bulk deletion; never load binary audio, and do not leave a fixed-size daily backlog.
  const clips = await prisma.speechClip.deleteMany({ where: { expiresAt: { lt: now } } });
  const days = await prisma.speechDailyQuota.deleteMany({ where: { day: { lt: moscowDayKey(now.getTime() - 30 * 86_400_000) } } });
  return { clips: clips.count, days: days.count };
}
