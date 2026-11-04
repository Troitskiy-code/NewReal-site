import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedChatScope } from "@/lib/chatAccess";
import { requestedThreadId } from "@/lib/chatThreads";
import { getSpeechRecognitionEditor, recognizeSceneSpeech, correctSpeechRecognition, SpeechRecognitionError, speechRecognitionEnabled } from "@/lib/speechRecognition";
import { ChatSpeechError } from "@/lib/chatSpeech";
import { readSpeechEdit } from "@/lib/speechEdits";
import { consumeRateLimit } from "@/lib/rateLimit";
import { setAiCostActor, withAiCostContext } from "@/lib/aiCostTelemetry";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 90;
const PRIVATE = { "Cache-Control": "private, no-store", Vary: "Cookie" };
type Context = { params: Promise<{ id: string }> };
const problem = (code: string, status: number) => NextResponse.json({ code }, { status, headers: PRIVATE });

async function handle(req: NextRequest, context: Context, generate: boolean) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return problem("unauthorized", 401);
    if (!speechRecognitionEnabled()) return problem("unavailable", 503);
    if (generate) {
      const origin = req.headers.get("origin");
      const allowed = new Set([new URL(req.url).origin]);
      if (process.env.NEXTAUTH_URL) allowed.add(new URL(process.env.NEXTAUTH_URL).origin);
      if (req.headers.get("sec-fetch-site") === "cross-site" || (origin && !allowed.has(origin))) return problem("forbidden", 403);
    }
    // A bounded URL contains identifiers only; submitted text, cast and provider options are never accepted.
    const messageId = req.nextUrl.searchParams.get("messageId");
    if (!messageId || !/^[a-zA-Z0-9_-]{1,128}$/.test(messageId)) return problem("invalid", 400);
    const { id } = await context.params;
    const access = await getAuthorizedChatScope(session.user.id, id, requestedThreadId(req));
    if ("error" in access) return problem("notFound", access.status);
    if (access.resolution.status !== "found") return problem("notFound", 404);
    const scope = access.resolution.scope;
    const saved = await getSpeechRecognitionEditor(scope, messageId);
    if (!generate || saved.recognition) return NextResponse.json(saved, { headers: PRIVATE });
    if (!(await consumeRateLimit(`speech-recognition:${session.user.id}`, 10, 60_000)).ok) return problem("rateLimit", 429);
    setAiCostActor(session.user.id);
    const result = await recognizeSceneSpeech(scope, messageId);
    return NextResponse.json({ recognition: result, options: [...new Map([...saved.options, ...result.speakers].map(speaker => [speaker.id, speaker])).values()] }, { headers: PRIVATE });
  } catch (error) {
    if (error instanceof SpeechRecognitionError) return problem(error.code, error.status);
    errorLog("SpeechRecognition", "Scene recognition unavailable", toSafeDiagnostic(error));
    return problem("unavailable", 503);
  }
}

export async function GET(req: NextRequest, context: Context) { return handle(req, context, false); }
export async function POST(req: NextRequest, context: Context) { return withAiCostContext(() => handle(req, context, true)); }

export async function PATCH(req: NextRequest, context: Context) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return problem("unauthorized", 401);
    if (!speechRecognitionEnabled()) return problem("unavailable", 503);
    const body = await readSpeechEdit(req);
    const messageId = req.nextUrl.searchParams.get("messageId");
    if (!messageId || !/^[a-zA-Z0-9_-]{1,128}$/.test(messageId) || typeof body.revision !== "string" || body.revision.length > 160
      || !Number.isInteger(body.segmentIndex) || typeof body.speakerId !== "string" || body.speakerId.length > 100
      || (body.kind !== "dialogue" && body.kind !== "narration") || (body.name !== undefined && typeof body.name !== "string")) return problem("invalid", 400);
    const { id } = await context.params;
    const access = await getAuthorizedChatScope(session.user.id, id, requestedThreadId(req));
    if ("error" in access || access.resolution.status !== "found") return problem("notFound", 404);
    if (!(await consumeRateLimit(`speech-edit:${session.user.id}`, 60, 60_000)).ok) return problem("rateLimit", 429);
    return NextResponse.json(await correctSpeechRecognition(access.resolution.scope, messageId, {
      revision: body.revision, segmentIndex: body.segmentIndex as number, speakerId: body.speakerId, kind: body.kind, name: body.name as string | undefined,
    }), { headers: PRIVATE });
  } catch (error) {
    if (error instanceof ChatSpeechError || error instanceof SpeechRecognitionError) return problem(error.code, error.status);
    errorLog("SpeechRecognition", "Correction unavailable", toSafeDiagnostic(error));
    return problem("unavailable", 503);
  }
}
