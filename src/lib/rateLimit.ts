import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

export type RateLimitResult = { ok: true; remaining: number } | { ok: false; remaining: 0; retryAfterMs: number };

// One atomic counter in PostgreSQL, shared by every application instance.
export async function consumeRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) throw new Error("Invalid rate limit");
  const hash = createHash("sha256").update(key).digest("hex");
  const [row] = await prisma.$queryRaw<Array<{ count: number; retryAfterMs: number }>>`
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

export function clientKeyFromRequest(req: { headers: { get(name: string): string | null } }): string {
  if (process.env['TRUST_PROXY'] === "1") {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    const realIp = req.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }
  return "unknown";
}
