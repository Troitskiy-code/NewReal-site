import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type RateLimitResult = { ok: true; remaining: number } | { ok: false; remaining: 0; retryAfterMs: number };

const bucketHash = (key: string) => createHash("sha256").update(key).digest("hex");

// One atomic counter in PostgreSQL, shared by every application instance.
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  client: Prisma.TransactionClient = prisma
): Promise<RateLimitResult> {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) throw new Error("Invalid rate limit");
  const hash = bucketHash(key);
  const [row] = await client.$queryRaw<Array<{ count: number; retryAfterMs: number }>>`
    INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
    VALUES (${hash}, 1, clock_timestamp() + ${windowMs} * interval '1 millisecond')
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimitBucket"."resetAt" <= clock_timestamp() THEN 1
        ELSE LEAST("RateLimitBucket"."count" + 1, ${limit + 1}) END,
      "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= clock_timestamp()
        THEN clock_timestamp() + ${windowMs} * interval '1 millisecond' ELSE "RateLimitBucket"."resetAt" END
    RETURNING "count", GREATEST(0, EXTRACT(EPOCH FROM ("resetAt" - clock_timestamp())) * 1000)::float8 AS "retryAfterMs"
  `;
  if (row.count > limit) return { ok: false, remaining: 0, retryAfterMs: row.retryAfterMs };
  return { ok: true, remaining: Math.max(0, limit - row.count) };
}

/** Remaining calls in the current window, without consuming one. */
export async function peekRateLimit(key: string, limit: number): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT "count" FROM "RateLimitBucket" WHERE "key" = ${bucketHash(key)} AND "resetAt" > clock_timestamp()
  `;
  return Math.max(0, limit - (row?.count ?? 0));
}

type HeaderSource = { headers: { get(name: string): string | null } };

/**
 * Per-IP limit. Without TRUST_PROXY the client IP is unknown, so every caller shares one
 * bucket with the larger sharedLimit: a backstop against floods that rarely hits real users.
 */
export function consumeIpRateLimit(
  req: HeaderSource,
  scope: string,
  { limit, sharedLimit, windowMs }: { limit: number; sharedLimit: number; windowMs: number }
): Promise<RateLimitResult> {
  const ip = clientKeyFromRequest(req);
  return ip === "unknown"
    ? consumeRateLimit(`${scope}:shared`, sharedLimit, windowMs)
    : consumeRateLimit(`${scope}:ip:${ip}`, limit, windowMs);
}

export function retryAfterSeconds(result: RateLimitResult): string {
  return String("retryAfterMs" in result ? Math.max(1, Math.ceil(result.retryAfterMs / 1000)) : 0);
}

export function clientKeyFromRequest(req: HeaderSource): string {
  if (process.env['TRUST_PROXY'] === "1") {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    const realIp = req.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }
  return "unknown";
}

const PRIVATE_ADDRESS = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd][0-9a-f]{2}:|::ffff:(10|127|192\.168)\.)/i;

/**
 * TEMPORARY (guest IP quota rollout): the shape of the proxy's client-address headers, never the addresses.
 * Shows whether the proxy overwrites or appends X-Forwarded-For, so the right entry can be trusted.
 */
export function describeForwardedHeaders(req: HeaderSource) {
  const entries = (req.headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  const realIp = req.headers.get("x-real-ip")?.trim() || null;
  const kind = (value: string | null | undefined) => (value ? (PRIVATE_ADDRESS.test(value) ? "private" : "public") : "none");
  return {
    trustProxy: process.env["TRUST_PROXY"] === "1",
    forwardedEntries: entries.length,
    forwardedFirst: kind(entries[0]),
    forwardedLast: kind(entries.at(-1)),
    realIp: kind(realIp),
    realIpIs: !realIp ? "none" : realIp === entries.at(-1) ? "last" : realIp === entries[0] ? "first" : "other",
    // 203.0.113.0/24 is the documentation range a probe sends as a spoofed client header.
    spoofedAt: entries.findIndex((entry) => entry.startsWith("203.0.113.")),
    realIpSpoofed: Boolean(realIp?.startsWith("203.0.113.")),
  };
}
