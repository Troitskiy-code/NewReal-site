import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAuthorizedChatScope } from "@/lib/chatAccess";
import { messageScopeWhere, requestedThreadId } from "@/lib/chatThreads";
import { applyPendingSubscriptionIfDue } from "@/lib/subscriptionState";
import { ChatSpeechError, attachSpeechTask, deferSpeech, failSpeech, finishSpeech, getSpeechQuota, reserveSpeech,
  getPreparedSpeechText, markSpeechSubmitting, saveSpeechPreparation, speechNarratorEnabled } from "@/lib/chatSpeech";
import { prepareSpeechText, prepareSceneSpeech, SpeechPreparationError } from "@/lib/speechPreparation";
import { downloadSpeech, getSpeechTask, SpeechProviderError, submitSpeech, speechEnabled } from "@/lib/speechProvider";
import { isSpeechVoice, isSpeechVoiceChoice, isSpeechContentMode, speechCast, type SpeechQuota, type SpeechContentMode } from "@/lib/speech";
import { getAutomaticSpeechVoice } from "@/lib/speechVoiceSelection";
import { speechRecognitionEnabled, getSpeechRecognition, recognizeSceneSpeech, SpeechRecognitionError } from "@/lib/speechRecognition";
import { sceneSpeechEnabled, storySpeechVoices, sceneSpeechKey, listStoryVoices } from "@/lib/storySpeechVoices";
import { speechRecognitionRevision } from "@/lib/speechRecognitionShared";
import { initializeSceneSpeech, advanceSceneSpeech } from "@/lib/sceneSpeechJobs";
import { consumeRateLimit } from "@/lib/rateLimit";
import { recordKieSpeechCost, setAiCostActor, withAiCostContext } from "@/lib/aiCostTelemetry";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 120;
const PRIVATE = { "Cache-Control": "private, no-store", Vary: "Cookie" };
type Context = { params: Promise<{ id: string }> };
function problem(code: string, status: number) {
  return NextResponse.json({ code }, { status, headers: PRIVATE });
}
function pendingResponse(text: string | null, voice: string, contentMode: SpeechContentMode, narrated: boolean, castKey = "") {
  return NextResponse.json({ pending: true, text, voice, contentMode, narrated, ...(castKey ? { castKey } : {}) }, { status: 202, headers: { ...PRIVATE, "Retry-After": "4" } });
}
function audioResponse(audio: Buffer, quota: SpeechQuota, voice: string, contentMode: SpeechContentMode, narrated: boolean, castKey = "") {
  return new Response(new Uint8Array(audio), { headers: { ...PRIVATE, "Content-Type": "audio/mpeg",
    "Content-Length": String(audio.length), "X-Content-Type-Options": "nosniff",
    "X-Speech-Unlimited": String(quota.unlimited), "X-Speech-Remaining": String(quota.remaining ?? -1),
    "X-Speech-Resets-At": quota.resetsAt, "X-Speech-Voice": voice, "X-Speech-Content-Mode": contentMode, "X-Speech-Narrated": String(narrated), "X-Speech-Cast-Key": castKey } });
}

export async function GET(req: NextRequest, context: Context) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return problem("unauthorized", 401);
    const { id } = await context.params;
    const access = await getAuthorizedChatScope(session.user.id, id, requestedThreadId(req));
    if ("error" in access) return problem("notFound", access.status);
    await applyPendingSubscriptionIfDue(session.user.id);
    const messageId = req.nextUrl.searchParams.get("messageId");
    if (messageId) {
      if (access.resolution.status !== "found") return problem("notFound", 404);
      const message = await prisma.message.findFirst({ where: { ...messageScopeWhere(access.resolution.scope),
        id: messageId, role: "assistant" }, select: { id: true } });
      if (!message) return problem("notFound", 404);
      const choice = req.nextUrl.searchParams.get("voice") ?? "auto";
      if (!isSpeechVoiceChoice(choice)) return problem("invalid", 400);
      const automatic = await getAutomaticSpeechVoice(id, access.resolution.scope.threadId);
      const voice = isSpeechVoice(choice) ? choice : automatic.voice;
      const requestedMode = req.nextUrl.searchParams.get("contentMode");
      if (requestedMode !== null && !isSpeechContentMode(requestedMode)) return problem("invalid", 400);
      // Metadata can inspect an owned existing clip prepared before a story-mode change; it starts no paid work.
      const contentMode: SpeechContentMode = isSpeechContentMode(requestedMode) ? requestedMode : automatic.contentMode;
      const requestedNarration = req.nextUrl.searchParams.get("narrated");
      if (requestedNarration !== null && requestedNarration !== "true" && requestedNarration !== "false") return problem("invalid", 400);
      const narrator = requestedNarration === null ? automatic.contentMode === "scene" && speechNarratorEnabled() : requestedNarration === "true";
      const castKey = req.nextUrl.searchParams.get("castKey") ?? "";
      if (castKey && !/^[a-f0-9]{64}$/.test(castKey)) return problem("invalid", 400);
      return NextResponse.json({ text: await getPreparedSpeechText({ userId: session.user.id, characterId: id, messageId, voice, contentMode, narrator, castKey }) }, { headers: PRIVATE });
    }
    const [quota, automatic] = await Promise.all([getSpeechQuota(session.user.id), getAutomaticSpeechVoice(id,
      access.resolution.status === "found" ? access.resolution.scope.threadId : null)]);
    const cast = access.resolution.status === "found" && sceneSpeechEnabled() ? await listStoryVoices(access.resolution.scope) : { cast: [], revision: null };
    return NextResponse.json({ ...quota, automatic, contentMode: automatic.contentMode, cast: cast.cast, castRevision: cast.revision, castEnabled: sceneSpeechEnabled() && speechRecognitionEnabled(),
      narrated: automatic.contentMode === "scene" && speechNarratorEnabled(), recognitionEnabled: speechRecognitionEnabled() }, { headers: PRIVATE });
  } catch (error) {
    errorLog("Speech", "Speech status unavailable", toSafeDiagnostic(error));
    return problem("unavailable", 503);
  }
}

export async function POST(req: NextRequest, context: Context) {
  return withAiCostContext(async () => {
    let job: Awaited<ReturnType<typeof reserveSpeech>> | undefined;
    let terminalFailure = false;
    let stage = "authorize";
    const started = Date.now();
    try {
      // No user-supplied text or provider URLs. Only an owned, persisted assistant message.
      const origin = req.headers.get("origin");
      const allowed = new Set([new URL(req.url).origin]);
      if (process.env.NEXTAUTH_URL) allowed.add(new URL(process.env.NEXTAUTH_URL).origin);
      if (req.headers.get("sec-fetch-site") === "cross-site" || (origin && !allowed.has(origin))) return problem("forbidden", 403);
      const session = await getServerSession(authOptions);
      if (!session?.user?.id) return problem("unauthorized", 401);
      if (!speechEnabled()) return problem("unavailable", 503);
      if (!(await consumeRateLimit(`speech:${session.user.id}`, 30, 60_000)).ok) return problem("rateLimit", 429);
      if (!req.headers.get("content-type")?.includes("application/json")) return problem("invalid", 400);
      const reader = req.body?.getReader();
      if (!reader) return problem("invalid", 400);
      const pieces: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_048) { await reader.cancel(); return problem("invalid", 413); }
          pieces.push(value);
        }
      } finally { reader.releaseLock(); }
      let body: { messageId?: unknown; voice?: unknown };
      try { body = JSON.parse(Buffer.concat(pieces).toString("utf8")); }
      catch { return problem("invalid", 400); }
      if (!body || typeof body !== "object" || typeof body.messageId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.messageId)
        || (body.voice !== undefined && !isSpeechVoiceChoice(body.voice))) return problem("invalid", 400);
      const { id: characterId } = await context.params;
      const access = await getAuthorizedChatScope(session.user.id, characterId, requestedThreadId(req));
      if ("error" in access) return problem("notFound", access.status);
      if (access.resolution.status !== "found") return problem("notFound", 404);
      const message = await prisma.message.findFirst({ where: { ...messageScopeWhere(access.resolution.scope),
        id: body.messageId, role: "assistant" }, select: { id: true } });
      if (!message) return problem("notFound", 404);
      const user = await applyPendingSubscriptionIfDue(session.user.id);
      setAiCostActor(session.user.id, user?.subscriptionType);
      stage = "reserve";
      const automatic = await getAutomaticSpeechVoice(characterId, access.resolution.scope.threadId);
      let voice = isSpeechVoice(body.voice) ? body.voice : automatic.voice;
      const ensemble = sceneSpeechEnabled() && speechRecognitionEnabled();
      let script: Awaited<ReturnType<typeof recognizeSceneSpeech>> | undefined;
      let voices: Awaited<ReturnType<typeof storySpeechVoices>> | undefined;
      if (ensemble) {
        const allowance = await getSpeechQuota(session.user.id);
        if (!allowance.unlimited && allowance.remaining === 0) return problem("quota", 429);
        script = await getSpeechRecognition(access.resolution.scope, message.id) ?? undefined;
        if (!script) {
          if (!(await consumeRateLimit(`speech-recognition:${session.user.id}`, 10, 60_000)).ok) return problem("rateLimit", 429);
          script = await recognizeSceneSpeech(access.resolution.scope, message.id);
        }
        if ((script.mode === "world" ? "scene" : "dialogue") !== automatic.contentMode) return problem("changed", 409);
        voices = await storySpeechVoices(access.resolution.scope, script, voice, isSpeechVoice(body.voice));
        const first = script.segments.find(segment => segment.kind === "dialogue" || script!.mode === "world");
        // Cache identity follows the actual cast, including replies where the selected main hero is absent.
        if (first) voice = voices[first.speakerId] ?? voice;
      }
      job = await reserveSpeech({ userId: session.user.id, characterId, messageId: message.id,
        voice, contentMode: automatic.contentMode, narrator: automatic.contentMode === "scene" && speechNarratorEnabled(),
        ...(script && voices ? { castKey: sceneSpeechKey(script, voices), scene: { threadId: access.resolution.scope.threadId,
          revision: speechRecognitionRevision(script), mode: script.mode, voices } } : {}) });
      if (job.kind === "cached") return audioResponse(job.audio, job.quota, voice, job.contentMode, job.narrator, job.castKey);
      const reservation = job.reservation;
      if (reservation.uncertain) throw new ChatSpeechError("uncertain", 503);
      if (reservation.castKey) {
        stage = "scene";
        if (reservation.preparedText === null || reservation.preparedTurns === null) {
          const character = script!.mode === "character" ? await prisma.character.findUnique({ where: { id: characterId },
            select: { name: true, description: true, appearance: true } }) : undefined;
          await saveSpeechPreparation(reservation, await prepareSceneSpeech(reservation.text, script!, voices!, character ?? undefined));
        }
        if (!reservation.preparedText) throw new ChatSpeechError(reservation.contentMode === "dialogue" ? "noDialogue" : "empty", 400);
        if (!reservation.providerTaskId) {
          await initializeSceneSpeech(reservation);
          await deferSpeech(reservation);
          return pendingResponse(reservation.preparedText, voice, reservation.contentMode, reservation.narrator, reservation.castKey);
        }
        const audio = await advanceSceneSpeech(reservation);
        if (!audio) {
          await deferSpeech(reservation);
          return pendingResponse(reservation.preparedText, voice, reservation.contentMode, reservation.narrator, reservation.castKey);
        }
        return audioResponse(audio, await finishSpeech(reservation, audio), voice, reservation.contentMode, reservation.narrator, reservation.castKey);
      }
      if (!reservation.providerTaskId) {
        stage = "prepare";
        if (reservation.preparedText === null || reservation.preparedTurns === null) {
          // The card tells the preparation who is speaking, so the casting note matches the character.
          const character = await prisma.character.findUnique({ where: { id: characterId },
            select: { name: true, description: true, appearance: true } });
          await saveSpeechPreparation(reservation, await prepareSpeechText(reservation.text, character ?? undefined, reservation.contentMode, reservation.narrator));
        }
        if (!reservation.preparedText) throw new ChatSpeechError(reservation.contentMode === "dialogue" && !reservation.narrator ? "noDialogue" : "empty", 400);
        stage = "submit";
        await markSpeechSubmitting(reservation);
        await recordKieSpeechCost(reservation, reservation.model, "pending");
        // One task and one cost event: narration and spoken lines are two speakers of the same recording, in source order.
        const cast = reservation.narrator ? speechCast(reservation.voice, reservation.contentMode, reservation.preparedTurns!) : null;
        const taskId = cast ? await submitSpeech(reservation.preparedTurns!, cast.character, reservation.model, cast.narrator)
          : await submitSpeech(reservation.preparedTurns!, reservation.voice, reservation.model);
        await attachSpeechTask(reservation, taskId);
        // Keep preparation/submission and result download in separate bounded requests.
        await deferSpeech(reservation);
        return pendingResponse(reservation.preparedText, reservation.voice, reservation.contentMode, reservation.narrator);
      }
      stage = "poll";
      const task = await getSpeechTask(reservation.providerTaskId!, reservation.model);
      await recordKieSpeechCost(reservation, reservation.model, task.state === "ready" ? "completed" : task.state === "failed" ? "failed" : "pending", task.credits);
      if (task.state === "failed") { terminalFailure = true; throw new SpeechProviderError(); }
      if (task.state === "pending") {
        await deferSpeech(reservation);
        return pendingResponse(reservation.preparedText, reservation.voice, reservation.contentMode, reservation.narrator);
      }
      stage = "download";
      const audio = await downloadSpeech(task.url!);
      stage = "deliver";
      return audioResponse(audio, await finishSpeech(job.reservation, audio), voice, job.reservation.contentMode, job.reservation.narrator);
    } catch (error) {
      if (job?.kind === "reserved") {
        if (terminalFailure || (!job.reservation.castKey && error instanceof SpeechProviderError && error.definitive && !job.reservation.providerTaskId)
          || (error instanceof ChatSpeechError && error.code === "changed")) {
          if (!job.reservation.providerTaskId) await recordKieSpeechCost(job.reservation, job.reservation.model, "failed");
          await failSpeech(job.reservation).catch(() => {});
        } else await deferSpeech(job.reservation).catch(() => {});
      }
      if (error instanceof ChatSpeechError) return problem(error.code, error.status);
      if (error instanceof SpeechRecognitionError) return problem(error.code, error.status);
      errorLog("Speech", "Speech generation unavailable", { stage, durationMs: Date.now() - started,
        status: error instanceof SpeechProviderError ? error.status ?? null : null,
        reason: error instanceof SpeechPreparationError ? error.reason : error instanceof SpeechProviderError ? error.reason : "unexpected",
        providerRequestId: job?.kind === "reserved" ? job.reservation.providerTaskId : null }, toSafeDiagnostic(error));
      // A known accepted task survives transient poll/media failures. Let the existing client poll recover it.
      if (!terminalFailure && job?.kind === "reserved" && job.reservation.providerTaskId
        && error instanceof SpeechProviderError && !error.definitive) return pendingResponse(job.reservation.preparedText, job.reservation.voice, job.reservation.contentMode, job.reservation.narrator, job.reservation.castKey);
      if (error instanceof SpeechPreparationError && error.reason === "too_long") return problem("tooLong", 400);
      return problem("unavailable", 503);
    }
  });
}
