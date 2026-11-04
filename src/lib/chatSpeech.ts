import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { moscowDayKey, nextMoscowMidnight } from "./freeDailyQuota";
import { getSubscriptionPlan } from "./chatEconomy";
import { speechSource, SPEECH_SOURCE_MAX_CHARACTERS, SPEECH_PREPARATION_VERSION, SPEECH_NARRATOR_PREPARATION_VERSION, SPEECH_VOICES, type PreparedSpeech, type SpeechTurn, type SpeechVoice, type SpeechQuota, type SpeechContentMode } from "./speech";
import { SPEECH_MODEL, SPEECH_EXPRESSIVE_MODEL, SPEECH_CACHE_VERSION, speechEnabled, speechModelFor, type SpeechModel } from "./speechProvider";
import { speechRecognitionRevision, type SpeechRecognitionResult } from "./speechRecognitionShared";
import { roleplayMode } from "./roleplayConfig";
import { threadPromptScopeKey } from "./chatThreads";

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

/** Separate narrator for worlds only. `false` keeps world narration in a single voice. */
export function speechNarratorEnabled(): boolean {
  return process.env.CHAT_SPEECH_NARRATOR_ENABLED !== "false";
}
export function speechClipId(userId: string, messageId: string, text: string, voice: SpeechVoice, model: SpeechModel = SPEECH_MODEL,
  contentMode: SpeechContentMode = "dialogue", narrator = false, castKey = ""): string {
  return createHash("sha256").update(JSON.stringify([narrator ? SPEECH_NARRATOR_PREPARATION_VERSION : SPEECH_PREPARATION_VERSION,
    SPEECH_CACHE_VERSION, model, contentMode, userId, messageId, text, voice, ...(castKey ? ["ensemble-v1", castKey] : [])])).digest("hex");
}
/** Every cache id a reply may have: preparation is shared across voices and plan models. */
function allSpeechClipIds(userId: string, messageId: string, text: string, contentMode: SpeechContentMode, narrator: boolean, castKey = "") {
  return SPEECH_VOICES.flatMap(voice => ([SPEECH_MODEL, SPEECH_EXPRESSIVE_MODEL] as const)
    .map(model => speechClipId(userId, messageId, text, voice.id, model, contentMode, narrator, castKey)));
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

type Source = { userId: string; characterId: string; messageId: string; voice: SpeechVoice; contentMode?: SpeechContentMode; narrator?: boolean; castKey?: string;
  scene?: { threadId: string; revision: string; mode: "character" | "group" | "world"; voices: Record<string, SpeechVoice> } };
export type SpeechReservation = Source & { id: string; model: SpeechModel; contentMode: SpeechContentMode; narrator: boolean; token: string; text: string; preparedText: string | null; preparedTurns: SpeechTurn[] | null; freeDay: string | null;
  providerTaskId: string | null; costEventId: string; uncertain: boolean; startedAt: Date };
type Reserved = { kind: "cached"; audio: Buffer; quota: SpeechQuota; contentMode: SpeechContentMode; narrator: boolean; castKey?: string } | { kind: "reserved"; reservation: SpeechReservation };

export async function reserveSpeech(source: Source, now = new Date()): Promise<Reserved> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const user = await lockUser(tx, source.userId);
    const message = await tx.message.findFirst({ where: { id: source.messageId, userId: source.userId,
      characterId: source.characterId, role: "assistant" }, select: { content: true, speechRecognition: true } });
    if (!message) throw new ChatSpeechError("notFound", 404);
    if (source.scene) {
      // Close the gap between preparing a cast and reserving paid work. Editors use this same user lock.
      const [thread, state, card] = await Promise.all([
        tx.chatThread.findFirst({ where: { id: source.scene.threadId, userId: source.userId, characterId: source.characterId }, select: { speechVoices: true } }),
        tx.chatPromptState.findUnique({ where: { scopeKey_characterId: { scopeKey: threadPromptScopeKey(source.scene.threadId), characterId: source.characterId } }, select: { mode: true } }),
        tx.character.findUnique({ where: { id: source.characterId }, select: { roleplayMode: true } }),
      ]);
      const script = (message.speechRecognition as unknown as { status?: string; result?: SpeechRecognitionResult } | null);
      const cast = thread?.speechVoices as unknown as { speakers?: { id: string; voice: string }[] } | null;
      if (!thread || !script?.result || script.status !== "ready" || speechRecognitionRevision(script.result) !== source.scene.revision
        || roleplayMode(state?.mode ?? card?.roleplayMode) !== source.scene.mode
        || Object.entries(source.scene.voices).some(([id, voice]) => !(id === "narrator" && source.scene!.mode !== "world")
          && !cast?.speakers?.some(speaker => speaker.id === id && speaker.voice === voice))) throw new ChatSpeechError("changed", 409);
    }
    const text = speechSource(message.content);
    if (!text) throw new ChatSpeechError("empty", 400);
    if (Array.from(text).length > SPEECH_SOURCE_MAX_CHARACTERS) throw new ChatSpeechError("tooLong", 400);
    const state = await quota(tx, source.userId, user, now);
    // Paid plans hear the expressive model; the plan at reservation time decides (its own cache entry).
    const model = speechModelFor(state.unlimited);
    let contentMode = source.contentMode ?? "dialogue";
    let narrator = source.narrator ?? false;
    let id = speechClipId(source.userId, source.messageId, text, source.voice, model, contentMode, narrator, source.castKey);
    if (!state.unlimited && state.remaining === 0) throw new ChatSpeechError("quota", 429);
    // A cached play cannot spend the allowance while another paid synthesis is in flight.
    if (await tx.speechClip.findFirst({ where: { userId: source.userId, status: "processing", leaseUntil: { gt: now } }, select: { id: true } }))
      throw new ChatSpeechError("busy", 409);
    // A changed story mode or narrator setting cannot abandon an accepted (or uncertain) task and buy another one.
    const policies = (["dialogue", "scene"] as const).flatMap(mode => [false, true].map(narrated =>
      ({ mode, narrated, id: speechClipId(source.userId, source.messageId, text, source.voice, model, mode, narrated, source.castKey) })));
    const pinned = await tx.speechClip.findFirst({ where: { id: { in: policies.map(policy => policy.id) }, status: { in: ["pending", "processing"] },
      expiresAt: { gt: now }, OR: [{ providerTaskId: { not: null } }, { costEventId: { not: null } }] }, select: { id: true } });
    const policy = pinned && policies.find(candidate => candidate.id === pinned.id);
    // An accepted or uncertain narrated task cannot play in a dialogue-only category or buy a duplicate.
    if (policy && contentMode === "dialogue" && (policy.mode !== "dialogue" || policy.narrated))
      throw new ChatSpeechError("busy", 409);
    if (policy) { id = policy.id; contentMode = policy.mode; narrator = policy.narrated; }
    // A pending Kie task can be resumed for this reply; another reply cannot start alongside it.
    if (await tx.speechClip.findFirst({ where: { userId: source.userId, id: { not: id }, status: "pending",
      OR: [{ providerTaskId: "scene_cast_v1" }, { providerTaskId: { not: null }, updatedAt: { gt: new Date(now.getTime() - 30 * 60_000) } }] }, select: { id: true } }))
      throw new ChatSpeechError("busy", 409);
    const cached = await tx.speechClip.findUnique({ where: { id } });
    // A cache hit saves provider money, but still grants one new playback to this user.
    if (cached?.status === "ready" && cached.audio && cached.expiresAt > now) {
      if (!state.unlimited) await debitPlayback(tx, source.userId, moscowDayKey(now));
      await tx.speechClip.update({ where: { id }, data: { expiresAt: new Date(now.getTime() + CACHE_MS) } });
      return { kind: "cached", audio: Buffer.from(cached.audio), quota: await quota(tx, source.userId, user, now), contentMode, narrator, castKey: source.castKey };
    }

    // Both quota checks and leases share the user row lock.
    await tx.speechClip.deleteMany({ where: { userId: source.userId, OR: [
      { expiresAt: { lt: now } },
      { status: "processing", leaseUntil: { lte: now }, providerTaskId: null, costEventId: null },
    ] } });
    const token = randomUUID();
    const resume = cached && cached.status !== "ready" && cached.expiresAt > now;
    const providerTaskId = resume ? cached.providerTaskId : null;
    const costEventId = resume && cached.costEventId ? cached.costEventId : randomUUID();
    // Preparation is independent of the selected voice. Reuse only clips keyed to the current source/version.
    const prepared = await tx.speechClip.findFirst({ where: {
      id: { in: allSpeechClipIds(source.userId, source.messageId, text, contentMode, narrator, source.castKey) },
      preparedText: { not: null }, expiresAt: { gt: now },
    }, select: { preparedText: true, preparedTurns: true } });
    const preparedText = prepared?.preparedText ?? null;
    const preparedTurns = Array.isArray(prepared?.preparedTurns) ? prepared.preparedTurns as SpeechTurn[] : null;
    const startedAt = resume ? cached.createdAt : now;
    const data = { userId: source.userId, messageId: source.messageId, voice: source.voice, inputCharacters: Array.from(preparedText ?? text).length,
      status: "processing", audio: null, requestToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS),
      preparedText, preparedTurns: preparedTurns ?? Prisma.JsonNull, providerTaskId, costEventId: resume ? cached.costEventId : null,
      createdAt: startedAt, expiresAt: new Date(now.getTime() + CACHE_MS) };
    await tx.speechClip.upsert({ where: { id }, create: { id, ...data }, update: data });
    return { kind: "reserved", reservation: { ...source, contentMode, narrator, id, model, token, text, preparedText, preparedTurns, providerTaskId, costEventId, startedAt,
      uncertain: Boolean(resume && cached.costEventId && !providerTaskId), freeDay: state.unlimited ? null : moscowDayKey(now) } };
  });
}

export async function saveSpeechPreparation(job: SpeechReservation, prepared: PreparedSpeech) {
  const result = await prisma.speechClip.updateMany({ where: { id: job.id, requestToken: job.token,
    status: "processing", leaseUntil: { gt: new Date() } }, data: { preparedText: prepared.text, preparedTurns: prepared.turns,
      inputCharacters: Array.from(prepared.text).length } });
  if (!result.count) throw new ChatSpeechError("changed", 409);
  job.preparedText = prepared.text; job.preparedTurns = prepared.turns;
}

/** Persist submission intent only after preparation. A crash before this point is safe to retry. */
export async function markSpeechSubmitting(job: SpeechReservation) {
  const result = await prisma.speechClip.updateMany({ where: { id: job.id, requestToken: job.token,
    status: "processing", leaseUntil: { gt: new Date() } }, data: { costEventId: job.costEventId } });
  if (!result.count) throw new ChatSpeechError("changed", 409);
}

export async function getPreparedSpeechText(source: Source): Promise<string | null> {
  const message = await prisma.message.findFirst({ where: { id: source.messageId, userId: source.userId,
    characterId: source.characterId, role: "assistant" }, select: { content: true } });
  if (!message) throw new ChatSpeechError("notFound", 404);
  const text = speechSource(message.content);
  const clip = await prisma.speechClip.findFirst({ where: {
    id: { in: ([SPEECH_MODEL, SPEECH_EXPRESSIVE_MODEL] as const).map(model => speechClipId(source.userId, source.messageId, text, source.voice, model,
      source.contentMode ?? "dialogue", source.narrator ?? false, source.castKey)) },
    expiresAt: { gt: new Date() }, preparedText: { not: null },
  }, select: { preparedText: true } });
  return clip?.preparedText ?? null;
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
    if (!clip || !message || speechClipId(job.userId, job.messageId, speechSource(message.content), job.voice, job.model, job.contentMode, job.narrator, job.castKey) !== job.id)
      throw new ChatSpeechError("changed", 409);
    // A queued task can cross midnight or a subscription expiry. Charge the entitlement at delivery.
    if (!unlimitedSpeech(user, now)) await debitPlayback(tx, job.userId, moscowDayKey(now));
    await tx.speechClip.update({ where: { id: job.id }, data: { status: "ready", audio,
      requestToken: null, leaseUntil: null, expiresAt: new Date(now.getTime() + CACHE_MS) } });
    if (job.castKey) await tx.speechClipPart.deleteMany({ where: { clipId: job.id } });
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
