import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { classifySceneMood, sceneMoodMaterial } from "@/lib/sceneMood";
import { consumeIpRateLimit, consumeRateLimit, retryAfterSeconds } from "@/lib/rateLimit";
import { isSameOriginRequest } from "@/lib/telegram/http";
import { errorLog, toSafeDiagnostic } from "@/lib/logger";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
const HOUR = 60 * 60 * 1000;

/**
 * Picks the background music theme for the reader's latest scene. The client sends the visible text it
 * already shows; the answer is one word from a fixed list, so nothing else can be drawn out of the model.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isSameOriginRequest(req)) return NextResponse.json({ error: "Доступ запрещён" }, { status: 403, headers });
    const body = await req.json().catch(() => null) as { texts?: unknown } | null;
    const texts = sceneMoodMaterial(body?.texts);
    if (!texts) return NextResponse.json({ error: "Некорректный запрос" }, { status: 400, headers });
    const userId = (await getServerSession(authOptions))?.user?.id;
    const limit = userId ? await consumeRateLimit(`scene-mood:user:${userId}`, 240, HOUR)
      : await consumeIpRateLimit(req, "scene-mood", { limit: 120, sharedLimit: 3000, windowMs: HOUR });
    if (!limit.ok) {
      return NextResponse.json({ mood: null }, { status: 429, headers: { ...headers, "Retry-After": retryAfterSeconds(limit) } });
    }
    return NextResponse.json({ mood: await classifySceneMood(texts) }, { headers });
  } catch (error) {
    errorLog("Server", "[SceneMood] failed", toSafeDiagnostic(error));
    return NextResponse.json({ mood: null }, { status: 503, headers });
  }
}
