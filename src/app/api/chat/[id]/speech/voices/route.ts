import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getAuthorizedChatScope } from "@/lib/chatAccess";
import { requestedThreadId } from "@/lib/chatThreads";
import { readSpeechEdit } from "@/lib/speechEdits";
import { ChatSpeechError } from "@/lib/chatSpeech";
import { sceneSpeechEnabled, setStoryVoice } from "@/lib/storySpeechVoices";
import { isSpeechVoice } from "@/lib/speech";
import { consumeRateLimit } from "@/lib/rateLimit";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export const runtime = "nodejs";
const PRIVATE = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const problem = (code: string, status: number) => NextResponse.json({ code }, { status, headers: PRIVATE });
export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return problem("unauthorized", 401);
    if (!sceneSpeechEnabled()) return problem("unavailable", 503);
    const body = await readSpeechEdit(req);
    if (typeof body.speakerId !== "string" || body.speakerId.length > 100 || !isSpeechVoice(body.voice)
      || typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)) return problem("invalid", 400);
    const { id } = await context.params;
    const access = await getAuthorizedChatScope(session.user.id, id, requestedThreadId(req));
    if ("error" in access || access.resolution.status !== "found") return problem("notFound", 404);
    if (!(await consumeRateLimit(`speech-edit:${session.user.id}`, 60, 60_000)).ok) return problem("rateLimit", 429);
    return NextResponse.json(await setStoryVoice(access.resolution.scope, body.speakerId, body.voice, body.revision), { headers: PRIVATE });
  } catch (error) {
    if (error instanceof ChatSpeechError) return problem(error.code, error.status);
    errorLog("StoryVoices", "Voice change unavailable", toSafeDiagnostic(error));
    return problem("unavailable", 503);
  }
}
