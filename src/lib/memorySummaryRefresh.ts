import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { isDeferredSummaryFailure } from "./memorySummaryPolicy";

/** Reuse the existing lease store under a disjoint namespace; no schema rollout needed. */
export const SUMMARY_REFRESH_LEASE_SECONDS = 180;
export const SUMMARY_REFRESH_COOLDOWN_SECONDS = 120;
export const SUMMARY_SIZE_LIMIT_COOLDOWN_SECONDS = 1800;
export async function withSummaryRefreshLease<T>(threadId: string, run: () => Promise<T>, skipped: () => Promise<T>): Promise<T> {
  const id = `memory-summary:${createHash("sha256").update(threadId).digest("hex")}`;
  const owner = randomUUID();
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "EmbeddingBackfillLease" (id, owner, "leaseUntil")
    VALUES (${id}, ${owner}, (NOW() AT TIME ZONE 'UTC') + (${SUMMARY_REFRESH_LEASE_SECONDS} * INTERVAL '1 second'))
    ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, "leaseUntil" = EXCLUDED."leaseUntil"
    WHERE "EmbeddingBackfillLease"."leaseUntil" <= (NOW() AT TIME ZONE 'UTC')
    RETURNING id
  `;
  if (!claimed.length) return skipped();
  try {
    const result = await run();
    await prisma.$executeRaw`DELETE FROM "EmbeddingBackfillLease" WHERE id = ${id} AND owner = ${owner}`;
    return result;
  } catch (error) {
    const cooldown = isDeferredSummaryFailure(error) ? SUMMARY_SIZE_LIMIT_COOLDOWN_SECONDS : SUMMARY_REFRESH_COOLDOWN_SECONDS;
    // Release only our own claim; a timed-out owner cannot release a successor.
    await prisma.$executeRaw`
      UPDATE "EmbeddingBackfillLease" SET "leaseUntil" = (NOW() AT TIME ZONE 'UTC') + (${cooldown} * INTERVAL '1 second')
      WHERE id = ${id} AND owner = ${owner}
    `;
    throw error;
  }
}
