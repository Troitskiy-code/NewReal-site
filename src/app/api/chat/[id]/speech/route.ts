import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAuthorizedChatScope } from "@/lib/chatAccess";
import { messageScopeWhere, requestedThreadId } from "@/lib/chatThreads";
import { applyPendingSubscriptionIfDue } from "@/lib/subscriptionState";
import { ChatSpeechError, attachSpeechTask, deferSpeech, failSpeech, finishSpeech, getSpeechQuota, reserveSpeech,
  getPreparedSpeechText, markSpeechSubmitting, saveSpeechPreparation } from "@/lib/chatSpeech";
import { prepareSpeechText, SpeechPreparationError } from "@/lib/speechPreparation";
import { downloadSpeech, getSpeechTask, SPEECH_MODEL, SpeechProviderError, submitSpeech, speechEnabled } from "@/lib/speechProvider";
import { DEFAULT_SPEECH_VOICE, isSpeechVoice, type SpeechQuota } from "@/lib/speech";
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
function pendingResponse(text: string | null) {
  return NextResponse.json({ pending: true, text }, { status: 202, headers: { ...PRIVATE, "Retry-After": "4" } });
}
function audioResponse(audio: Buffer, quota: SpeechQuota) {
  return new Response(new Uint8Array(audio), { headers: { ...PRIVATE, "Content-Type": "audio/mpeg",
    "Content-Length": String(audio.length), "X-Content-Type-Options": "nosniff",
    "X-Speech-Unlimited": String(quota.unlimited), "X-Speech-Remaining": String(quota.remaining ?? -1),
    "X-Speech-Resets-At": quota.resetsAt } });
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
      const voice = req.nextUrl.searchParams.get("voice") ?? DEFAULT_SPEECH_VOICE;
      if (!isSpeechVoice(voice)) return problem("invalid", 400);
      return NextResponse.json({ text: await getPreparedSpeechText({ userId: session.user.id, characterId: id, messageId, voice }) }, { headers: PRIVATE });
    }
    return NextResponse.json(await getSpeechQuota(session.user.id), { headers: PRIVATE });
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
        || (body.voice !== undefined && !isSpeechVoice(body.voice))) return problem("invalid", 400);
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
      job = await reserveSpeech({ userId: session.user.id, characterId, messageId: message.id,
        voice: isSpeechVoice(body.voice) ? body.voice : DEFAULT_SPEECH_VOICE });
      if (job.kind === "cached") return audioResponse(job.audio, job.quota);
      const reservation = job.reservation;
      if (reservation.uncertain) throw new ChatSpeechError("uncertain", 503);
      if (!reservation.providerTaskId) {
        stage = "prepare";
        if (reservation.preparedText === null || reservation.preparedTurns === null)
          await saveSpeechPreparation(reservation, await prepareSpeechText(reservation.text));
        if (!reservation.preparedText) throw new ChatSpeechError("empty", 400);
        stage = "submit";
        await markSpeechSubmitting(reservation);
        await recordKieSpeechCost(reservation, SPEECH_MODEL, "pending");
        const taskId = await submitSpeech(reservation.preparedTurns!, reservation.voice);
        await attachSpeechTask(reservation, taskId);
        // Keep preparation/submission and result download in separate bounded requests.
        await deferSpeech(reservation);
        return pendingResponse(reservation.preparedText);
      }
      stage = "poll";
      const task = await getSpeechTask(reservation.providerTaskId!);
      await recordKieSpeechCost(reservation, SPEECH_MODEL, task.state === "ready" ? "completed" : task.state === "failed" ? "failed" : "pending", task.credits);
      if (task.state === "failed") { terminalFailure = true; throw new SpeechProviderError(); }
      if (task.state === "pending") {
        await deferSpeech(reservation);
        return pendingResponse(reservation.preparedText);
      }
      stage = "download";
      const audio = await downloadSpeech(task.url!);
      stage = "deliver";
      return audioResponse(audio, await finishSpeech(job.reservation, audio));
    } catch (error) {
      if (job?.kind === "reserved") {
        if (terminalFailure || (error instanceof SpeechProviderError && error.definitive && !job.reservation.providerTaskId)
          || (error instanceof ChatSpeechError && error.code === "changed")) {
          if (!job.reservation.providerTaskId) await recordKieSpeechCost(job.reservation, SPEECH_MODEL, "failed");
          await failSpeech(job.reservation).catch(() => {});
        } else await deferSpeech(job.reservation).catch(() => {});
      }
      if (error instanceof ChatSpeechError) return problem(error.code, error.status);
      errorLog("Speech", "Speech generation unavailable", { stage, durationMs: Date.now() - started,
        status: error instanceof SpeechProviderError ? error.status ?? null : null,
        reason: error instanceof SpeechPreparationError ? error.reason : error instanceof SpeechProviderError ? error.reason : "unexpected",
        providerRequestId: job?.kind === "reserved" ? job.reservation.providerTaskId : null }, toSafeDiagnostic(error));
      // A known accepted task survives transient poll/media failures. Let the existing client poll recover it.
      if (!terminalFailure && job?.kind === "reserved" && job.reservation.providerTaskId
        && error instanceof SpeechProviderError && !error.definitive) return pendingResponse(job.reservation.preparedText);
      if (error instanceof SpeechPreparationError && error.reason === "too_long") return problem("tooLong", 400);
      return problem("unavailable", 503);
    }
  });
}
