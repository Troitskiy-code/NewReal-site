-- Semantic search over memory events: one Qwen3-Embedding-0.6B vector (1024 dimensions) per event,
-- the same space as MessageEmbeddingDeepinfra. Additive and idempotent; the code falls back to word
-- overlap while the table is absent.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS "EpisodicEmbeddingDeepinfra" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "episodicId" TEXT NOT NULL,
  "embedding" vector(1024) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EpisodicEmbeddingDeepinfra_episodicId_fkey" FOREIGN KEY ("episodicId")
    REFERENCES "EpisodicMemory"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "EpisodicEmbeddingDeepinfra_episodicId_key" ON "EpisodicEmbeddingDeepinfra"("episodicId");
