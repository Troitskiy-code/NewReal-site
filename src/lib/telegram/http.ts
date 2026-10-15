import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export function telegramJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function secretEquals(expected: string | null, provided: string | null): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected), b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Requests that change sign-in state must come from our own pages. Browsers send
 * Sec-Fetch-Site; older webviews send Origin, compared with the Host the request reached.
 */
export function isSameOriginRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const host = (process.env.TRUST_PROXY === "1" && req.headers.get("x-forwarded-host")) || req.headers.get("host");
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function readLimitedJson(req: Request, maxBytes: number): Promise<unknown> {
  const raw = await req.text();
  if (raw.length > maxBytes) throw Object.assign(new Error("Body too large"), { status: 413 });
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}
