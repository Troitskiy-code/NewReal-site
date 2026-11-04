import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { isSpeechVoice, SPEECH_VOICES, type SpeechVoice } from "./speech";
import type { ChatScope } from "./chatThreads";
import type { SceneSpeaker, SpeechRecognitionResult } from "./speechRecognitionShared";
import { readRoleplayConfig, roleplayMode } from "./roleplayConfig";
import { ChatSpeechError } from "./chatSpeech";
import { readSpeechCast } from "./speechRecognition";
import { threadPromptScopeKey } from "./chatThreads";
import { automaticSpeechVoice } from "./speechVoiceSelection";
import { assertSpeechEditable } from "./speechEdits";

export type StorySpeechVoice = Pick<SceneSpeaker, "id" | "name" | "kind"> & { voice: SpeechVoice; manual?: boolean };
export function sceneSpeechEnabled() { return process.env.CHAT_SPEECH_CAST_ENABLED !== "false"; }
export function readStoryVoices(value: unknown): StorySpeechVoice[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const data = value as { version?: unknown; speakers?: unknown };
  if (data.version !== 1 || !Array.isArray(data.speakers)) return [];
  const seen = new Set<string>();
  return data.speakers.slice(0, 128).flatMap(item => {
    if (!item || typeof item.id !== "string" || typeof item.name !== "string" || seen.has(item.id)
      || !["character", "participant", "npc", "narrator"].includes(item.kind) || !isSpeechVoice(item.voice)) return [];
    seen.add(item.id);
    return [{ id: item.id, name: item.name, kind: item.kind, voice: item.voice, ...(item.manual === true ? { manual: true } : {}) } as StorySpeechVoice];
  });
}

/** Allocations belong to a story, not a browser or a particular message. Never reassign an existing NPC. */
export async function storySpeechVoices(scope: ChatScope, script: SpeechRecognitionResult, primaryVoice: SpeechVoice, manualPrimary = false) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${scope.userId} FOR UPDATE`;
    const thread = await tx.chatThread.findFirst({ where: { id: scope.threadId, userId: scope.userId, characterId: scope.characterId }, select: { speechVoices: true } });
    if (!thread) throw new ChatSpeechError("notFound", 404);
    const card = script.mode === "group" ? await tx.character.findUnique({ where: { id: scope.characterId }, select: { rpConfig: true } }) : null;
    const first = card && readRoleplayConfig(card.rpConfig).participants?.[0];
    const primaryId = script.mode === "world" ? "narrator" : script.mode === "character" ? "main" : first ? `participant:${first.id}` : "";
    const cast = new Map(readStoryVoices(thread.speechVoices).map(speaker => [speaker.id, speaker]));
    const used = new Set([...cast.values()].map(speaker => speaker.voice));
    if (script.mode !== "group" || manualPrimary) used.add(primaryVoice);
    const audible = new Set(script.segments.filter(segment => segment.kind === "dialogue" || script.mode === "world").map(segment => segment.speakerId));
    for (const speaker of script.speakers.filter(speaker => audible.has(speaker.id))) {
      // An unidentified line retains a fallback voice without inventing a narrator in character/group chats.
      if (speaker.id === "narrator" && script.mode !== "world") continue;
      const existing = cast.get(speaker.id);
      if (existing?.manual) continue;
      const primary = speaker.id === primaryId && (manualPrimary || (script.mode !== "group" && !existing));
      if (existing && !(speaker.id === primaryId && manualPrimary)) continue;
      if (existing && primary && existing.voice !== primaryVoice) await assertSpeechEditable(tx, scope);
      if (!cast.has(speaker.id) && cast.size >= 128) throw new ChatSpeechError("tooLong", 400);
      const pool = SPEECH_VOICES.filter(voice => script.mode === "group" && !manualPrimary || voice.id !== primaryVoice);
      const preferred = speaker.gender ? pool.filter(voice => voice.gender === speaker.gender) : pool;
      const choices = preferred.length ? preferred : pool;
      const voice = primary ? primaryVoice
        : (choices.find(voice => !used.has(voice.id)) ?? choices[cast.size % choices.length]).id;
      cast.set(speaker.id, { id: speaker.id, name: speaker.name, kind: speaker.kind, voice });
      used.add(voice);
    }
    await tx.chatThread.update({ where: { id: scope.threadId }, data: { speechVoices: { version: 1, speakers: [...cast.values()] } as unknown as Prisma.InputJsonValue } });
    return Object.fromEntries(script.speakers.filter(speaker => audible.has(speaker.id)).map(speaker => [speaker.id,
      speaker.id === "narrator" && script.mode !== "world" ? primaryVoice : cast.get(speaker.id)!.voice])) as Record<string, SpeechVoice>;
  });
}

export function storyVoicesRevision(cast: StorySpeechVoice[]) {
  return createHash("sha256").update(JSON.stringify(cast.map(speaker => [speaker.id, speaker.name, speaker.kind, speaker.voice, Boolean(speaker.manual)])
    .sort(([a], [b]) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))).digest("hex");
}

/** Read-only defaults let every card participant be configured before the first paid playback. */
export async function listStoryVoices(scope: ChatScope, db: Pick<Prisma.TransactionClient, "chatThread" | "character" | "chatPromptState"> = prisma) {
  const [thread, card, state] = await Promise.all([
    db.chatThread.findFirst({ where: { id: scope.threadId, userId: scope.userId, characterId: scope.characterId }, select: { speechVoices: true, speechCast: true } }),
    db.character.findUnique({ where: { id: scope.characterId }, select: { name: true, roleplayMode: true, rpConfig: true, tags: true, appearance: true, appearance_en: true, description: true, description_en: true } }),
    db.chatPromptState.findUnique({ where: { scopeKey_characterId: { scopeKey: threadPromptScopeKey(scope.threadId), characterId: scope.characterId } }, select: { mode: true } }),
  ]);
  if (!thread || !card) throw new ChatSpeechError("notFound", 404);
  const mode = roleplayMode(state?.mode ?? card.roleplayMode);
  const roster: SceneSpeaker[] = mode === "world" ? [{ id: "narrator", name: "", kind: "narrator", aliases: [] }]
    : mode === "character" ? [{ id: "main", name: card.name, kind: "character", aliases: [] }]
    : (readRoleplayConfig(card.rpConfig).participants ?? []).map(member => ({ id: `participant:${member.id}`, name: member.name, kind: "participant" as const, aliases: [] }));
  roster.push(...readSpeechCast(thread.speechCast).filter(speaker => !roster.some(member => member.name.normalize("NFKC").toLocaleLowerCase() === speaker.name.normalize("NFKC").toLocaleLowerCase())));
  const saved = new Map(readStoryVoices(thread.speechVoices).map(speaker => [speaker.id, speaker]));
  const used = new Set([...saved.values()].map(speaker => speaker.voice));
  const primaryVoice = automaticSpeechVoice(card, mode).voice;
  const cast: StorySpeechVoice[] = roster.map(speaker => {
    const current = saved.get(speaker.id);
    if (current) return { ...current, name: speaker.name, kind: speaker.kind };
    const pool = speaker.gender ? SPEECH_VOICES.filter(voice => voice.gender === speaker.gender) : SPEECH_VOICES;
    const voice = speaker.id === "main" || speaker.id === "narrator" ? primaryVoice
      : (pool.find(voice => !used.has(voice.id)) ?? pool[saved.size % pool.length]).id;
    used.add(voice);
    return { id: speaker.id, name: speaker.name, kind: speaker.kind, voice };
  });
  return { cast, revision: storyVoicesRevision(cast) };
}

export async function setStoryVoice(scope: ChatScope, speakerId: string, voice: SpeechVoice, revision: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${scope.userId} FOR UPDATE`;
    const current = await listStoryVoices(scope, tx);
    if (current.revision !== revision) throw new ChatSpeechError("changed", 409);
    const selected = current.cast.find(speaker => speaker.id === speakerId);
    if (!selected) throw new ChatSpeechError("invalid", 400);
    await assertSpeechEditable(tx, scope);
    const thread = await tx.chatThread.findUnique({ where: { id: scope.threadId }, select: { speechVoices: true } });
    const stored = new Map(readStoryVoices(thread?.speechVoices).map(speaker => [speaker.id, speaker]));
    for (const speaker of current.cast) stored.set(speaker.id, speaker.id === speakerId ? { ...speaker, voice, manual: true } : speaker);
    await tx.chatThread.update({ where: { id: scope.threadId }, data: { speechVoices: { version: 1, speakers: [...stored.values()] } as unknown as Prisma.InputJsonValue } });
    const cast = current.cast.map(speaker => speaker.id === speakerId ? { ...speaker, voice, manual: true } : speaker);
    return { cast, revision: storyVoicesRevision(cast) };
  });
}

export function sceneSpeechKey(script: SpeechRecognitionResult, voices: Record<string, SpeechVoice>) {
  return createHash("sha256").update(JSON.stringify(["story-voices-v1", script.sourceHash, script.contextHash, script.mode,
    script.segments.map(segment => [segment.start, segment.end, segment.text, segment.speakerId, segment.kind, segment.confidence]),
    Object.entries(voices).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)])).digest("hex");
}
