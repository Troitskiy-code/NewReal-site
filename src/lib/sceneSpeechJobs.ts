import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ChatSpeechError, type SpeechReservation } from "./chatSpeech";
import { isSpeechVoice, speechSource, type VoicedSpeechTurn } from "./speech";
import { submitSceneSpeech, getSpeechTask, downloadSpeechPcm, SpeechProviderError } from "./speechProvider";
import { speechPcmToMp3, SPEECH_WAV_LIMIT } from "./speechAudio";
import { recordKieSpeechCost } from "./aiCostTelemetry";

/** Greedy contiguous groups retain source order and never exceed the provider's two voices. */
export function sceneSpeechBatches(turns: VoicedSpeechTurn[]): VoicedSpeechTurn[][] {
  if (!turns.length || turns.length > 64 || turns.some(turn => !isSpeechVoice(turn.voice) || !turn.speakerId || !turn.text.trim()))
    throw new ChatSpeechError("invalid", 400);
  const batches: VoicedSpeechTurn[][] = [];
  let current: VoicedSpeechTurn[] = [], voices = new Set<string>();
  for (const turn of turns) {
    if (!voices.has(turn.voice) && voices.size === 2) { batches.push(current); current = []; voices = new Set(); }
    current.push(turn); voices.add(turn.voice);
  }
  if (current.length) batches.push(current);
  return batches;
}

async function leased(tx: Prisma.TransactionClient, job: SpeechReservation) {
  const clip = await tx.speechClip.findFirst({ where: { id: job.id, userId: job.userId, requestToken: job.token, status: "processing", leaseUntil: { gt: new Date() } }, select: { id: true } });
  const message = await tx.message.findFirst({ where: { id: job.messageId, userId: job.userId, characterId: job.characterId }, select: { content: true } });
  if (!clip || !message || speechSource(message.content) !== job.text) throw new ChatSpeechError("changed", 409);
}

export async function initializeSceneSpeech(job: SpeechReservation) {
  const batches = sceneSpeechBatches(job.preparedTurns as VoicedSpeechTurn[]);
  await prisma.$transaction(async tx => {
    await leased(tx, job);
    if (await tx.speechClipPart.count({ where: { clipId: job.id } })) return;
    await tx.speechClipPart.createMany({ data: batches.map((turns, position) => ({ id: randomUUID(), clipId: job.id, position, turns: turns as unknown as Prisma.InputJsonValue })) });
    await tx.speechClip.update({ where: { id: job.id }, data: { providerTaskId: "scene_cast_v1" } });
  });
  job.providerTaskId = "scene_cast_v1";
}

/** One bounded provider operation per request; every submission intent is persisted before the call. */
export async function advanceSceneSpeech(job: SpeechReservation): Promise<Buffer | null> {
  await prisma.$transaction(tx => leased(tx, job));
  const parts = await prisma.speechClipPart.findMany({ where: { clipId: job.id }, orderBy: { position: "asc" },
    select: { id: true, status: true, turns: true, providerTaskId: true, costEventId: true, createdAt: true } });
  if (!parts.length) throw new ChatSpeechError("changed", 409);
  const part = parts.find(part => part.status !== "ready");
  if (!part) {
    const gap = Buffer.alloc(4800); // 100 ms of mono 24 kHz PCM16 between provider batches.
    const audioParts = await prisma.speechClipPart.findMany({ where: { clipId: job.id }, orderBy: { position: "asc" }, select: { pcm: true } });
    if (audioParts.some(part => !part.pcm)) throw new ChatSpeechError("changed", 409);
    const streams = audioParts.flatMap((part, index) => index ? [gap, Buffer.from(part.pcm!)] : [Buffer.from(part.pcm!)]);
    if (streams.reduce((bytes, stream) => bytes + stream.length, 0) > SPEECH_WAV_LIMIT) throw new ChatSpeechError("tooLong", 400);
    return speechPcmToMp3(Buffer.concat(streams));
  }
  if (part.status === "invalid") throw new ChatSpeechError("tooLong", 400);
  if (part.status === "submitting" && !part.providerTaskId) throw new ChatSpeechError("uncertain", 503);
  const turns = part.turns as unknown as VoicedSpeechTurn[];
  const text = turns.map(turn => turn.text).join(" ");
  const ticket = { costEventId: part.costEventId ?? randomUUID(), userId: job.userId, providerTaskId: part.providerTaskId,
    text, preparedText: text, startedAt: part.createdAt };
  if (!part.providerTaskId || part.status === "failed") {
    ticket.costEventId = randomUUID(); ticket.providerTaskId = null;
    await prisma.$transaction(async tx => {
      await leased(tx, job);
      await tx.speechClipPart.update({ where: { id: part.id }, data: { status: "submitting", costEventId: ticket.costEventId, providerTaskId: null, createdAt: new Date() } });
    });
    await recordKieSpeechCost(ticket, job.model, "pending");
    try {
      const taskId = await submitSceneSpeech(turns, job.model);
      // Save an accepted task even if this HTTP lease expired while Kie replied. A replacement
      // request may observe the intent as uncertain, but cannot change this attempt's cost id.
      await prisma.speechClipPart.updateMany({ where: { id: part.id, costEventId: ticket.costEventId, status: "submitting", providerTaskId: null },
        data: { providerTaskId: taskId, status: "pending" } });
    } catch (error) {
      if (error instanceof SpeechProviderError && error.definitive) {
        await recordKieSpeechCost(ticket, job.model, "failed");
        await prisma.speechClipPart.updateMany({ where: { id: part.id, costEventId: ticket.costEventId, providerTaskId: null }, data: { status: "failed" } });
      }
      throw error;
    }
    return null;
  }
  const task = await getSpeechTask(part.providerTaskId, job.model);
  await recordKieSpeechCost(ticket, job.model, task.state === "ready" ? "completed" : task.state === "failed" ? "failed" : "pending", task.credits);
  if (task.state === "pending") return null;
  if (task.state === "failed") {
    await prisma.speechClipPart.update({ where: { id: part.id }, data: { status: "failed" } });
    throw new SpeechProviderError(undefined, true);
  }
  const pcm = await downloadSpeechPcm(task.url!);
  await prisma.$transaction(async tx => {
    await leased(tx, job);
    const size = await tx.$queryRaw<{ bytes: bigint }[]>`SELECT COALESCE(SUM(octet_length("pcm")),0)::bigint AS bytes FROM "SpeechClipPart" WHERE "clipId" = ${job.id}`;
    const tooLong = Number(size[0].bytes) + pcm.length + (parts.length - 1) * 4800 > SPEECH_WAV_LIMIT;
    await tx.speechClipPart.update({ where: { id: part.id }, data: tooLong ? { status: "invalid" } : { pcm, status: "ready" } });
  });
  return null;
}
