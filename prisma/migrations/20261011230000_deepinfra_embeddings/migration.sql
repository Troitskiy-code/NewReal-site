-- Apply before deploying the embedding migration code. Preserve the old vector space.
-- Existing MessageEmbedding (OpenAI, 1536 dimensions), messages and memories are untouched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE "MessageEmbeddingDeepinfra" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "messageId" TEXT NOT NULL,
  "embedding" vector(1024) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageEmbeddingDeepinfra_messageId_fkey" FOREIGN KEY ("messageId")
    REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MessageEmbeddingDeepinfra_messageId_key" ON "MessageEmbeddingDeepinfra"("messageId");
CREATE INDEX "MessageEmbeddingDeepinfra_embedding_hnsw_idx" ON "MessageEmbeddingDeepinfra"
  USING hnsw ("embedding" vector_cosine_ops);
CREATE TABLE "EmbeddingBackfillLease" (
  "id" TEXT NOT NULL PRIMARY KEY, "owner" TEXT NOT NULL, "leaseUntil" TIMESTAMP(3) NOT NULL
);
