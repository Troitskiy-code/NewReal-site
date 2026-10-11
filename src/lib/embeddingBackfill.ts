import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getEmbeddingProvider } from "./embeddingProviders";
import { isMessageEmbeddingsFlagEnabled } from "./ragEligibility";
import { saveMessageEmbeddingFromContent } from "./messageEmbeddings";
import { setAiCostActor, withAiCostContext } from "./aiCostTelemetry";
import { errorLog, toSafeDiagnostic } from "./logger";

const LEASE_ID = "deepinfra-qwen3-embedding-0.6b-v1";
const BATCH_SIZE = 10;

function eligibleMessages() {
  return {
    role: { in: ["user", "assistant"] }, content: { not: "" },
    deepinfraEmbedding: null,
    ...(isMessageEmbeddingsFlagEnabled() ? {} : {
      user: { subscriptionType: { in: ["dialog", "history", "story", "universe"] }, subscriptionEnd: { gt: new Date() } },
    }),
  };
}

/** Read-only: neither starts the provider nor acquires a lease. */
export async function embeddingBackfillStatus() {
  const [remaining, indexed] = await Promise.all([
    prisma.message.count({ where: eligibleMessages() }), prisma.messageEmbeddingDeepinfra.count(),
  ]);
  return { provider: getEmbeddingProvider(), remaining, indexed, batchSize: BATCH_SIZE };
}

/** Explicit POST only. Each call spends at most ten embedding requests, stops on the first failure. */
export async function backfillDeepinfraEmbeddings() {
  if (getEmbeddingProvider() !== "deepinfra") throw new Error("DeepInfra embeddings must be enabled first");
  const owner = randomUUID();
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "EmbeddingBackfillLease" (id, owner, "leaseUntil")
    VALUES (${LEASE_ID}, ${owner}, (NOW() AT TIME ZONE 'UTC') + INTERVAL '120 seconds')
    ON CONFLICT (id) DO UPDATE SET owner = EXCLUDED.owner, "leaseUntil" = EXCLUDED."leaseUntil"
    WHERE "EmbeddingBackfillLease"."leaseUntil" <= (NOW() AT TIME ZONE 'UTC')
    RETURNING id
  `;
  if (!claimed.length) return { busy: true, attempted: 0, saved: 0, skipped: 0, failed: 0 };
  const result = { busy: false, attempted: 0, saved: 0, skipped: 0, failed: 0 };
  try {
    const rows = await prisma.message.findMany({ where: eligibleMessages(), take: BATCH_SIZE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, content: true, userId: true, user: { select: { subscriptionType: true } } } });
    for (const row of rows) {
      const renewed = await prisma.$executeRaw`
        UPDATE "EmbeddingBackfillLease" SET "leaseUntil" = (NOW() AT TIME ZONE 'UTC') + INTERVAL '120 seconds'
        WHERE id = ${LEASE_ID} AND owner = ${owner} AND "leaseUntil" > (NOW() AT TIME ZONE 'UTC')
      `;
      if (!renewed) break;
      result.attempted++;
      try {
        const saved = await withAiCostContext(async () => {
          setAiCostActor(row.userId, row.user.subscriptionType);
          return saveMessageEmbeddingFromContent(row.id, row.content, "");
        });
        if (saved) result.saved++; else result.skipped++;
      } catch (error) {
        result.failed++;
        errorLog("EmbeddingBackfill", "batch stopped", toSafeDiagnostic(error));
        break;
      }
    }
    return result;
  } finally {
    // Failed runs retain a short cooldown. A stale owner cannot release a new worker's lease.
    if (result.failed) await prisma.$executeRaw`
      UPDATE "EmbeddingBackfillLease" SET "leaseUntil" = (NOW() AT TIME ZONE 'UTC') + INTERVAL '60 seconds'
      WHERE id = ${LEASE_ID} AND owner = ${owner}
    `;
    else await prisma.embeddingBackfillLease.deleteMany({ where: { id: LEASE_ID, owner } });
  }
}
