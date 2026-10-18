-- Additive stage 2. Apply on a restored copy and take a backup before production.
-- MEMORY_V2_ENABLED remains 0 until migration and worker acceptance are complete.
ALTER TABLE "ChatThread"
  ADD COLUMN "memoryLeaseOwner" TEXT,
  ADD COLUMN "memoryLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "memoryManualSeq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "memorySummaryInvalidated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "memoryNextSeq" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "memoryRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "memoryV2Initialized" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "memoryWatermarkMessageId" TEXT,
  ADD COLUMN "memoryWatermarkSeq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EpisodicMemory" ADD COLUMN "sourceMemoryJobId" TEXT;
CREATE INDEX "EpisodicMemory_sourceMemoryJobId_idx" ON "EpisodicMemory"("sourceMemoryJobId");

CREATE TABLE "MemoryFact" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "threadId" TEXT NOT NULL REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "subject" TEXT NOT NULL, "key" TEXT NOT NULL, "value" TEXT NOT NULL,
  "cardinality" TEXT NOT NULL CHECK ("cardinality" IN ('single', 'multi')),
  "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'superseded', 'retracted')),
  "supersededById" TEXT, "source" TEXT NOT NULL, "sourceMessageId" TEXT,
  "seq" INTEGER NOT NULL, "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "MemoryFact_threadId_status_idx" ON "MemoryFact"("threadId", "status");
CREATE INDEX "MemoryFact_threadId_subject_key_idx" ON "MemoryFact"("threadId", "subject", "key");
-- Prisma does not express partial indexes; these invariants are enforced by PostgreSQL.
CREATE UNIQUE INDEX "MemoryFact_active_single_key" ON "MemoryFact"("threadId", "subject", "key")
  WHERE "status" = 'active' AND "cardinality" = 'single';
CREATE UNIQUE INDEX "MemoryFact_active_value_key" ON "MemoryFact"("threadId", "subject", "key", md5("value"))
  WHERE "status" = 'active';

CREATE TABLE "MemoryJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "threadId" TEXT NOT NULL REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userMessageId" TEXT REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "assistantMessageId" TEXT REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "assistantMessageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "seq" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'awaiting_reply'
    CHECK ("status" IN ('awaiting_reply', 'queued', 'processing', 'retry', 'succeeded', 'failed', 'cancelled')),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3), "errorCode" TEXT, "sourceFingerprint" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "MemoryJob_userMessageId_key" ON "MemoryJob"("userMessageId");
CREATE UNIQUE INDEX "MemoryJob_assistantMessageId_key" ON "MemoryJob"("assistantMessageId");
CREATE UNIQUE INDEX "MemoryJob_threadId_seq_key" ON "MemoryJob"("threadId", "seq");
CREATE INDEX "MemoryJob_status_availableAt_idx" ON "MemoryJob"("status", "availableAt");
CREATE INDEX "MemoryJob_pending_seq_idx" ON "MemoryJob"("threadId", "seq") WHERE "status" NOT IN ('succeeded', 'cancelled');
ALTER TABLE "EpisodicMemory" ADD CONSTRAINT "EpisodicMemory_sourceMemoryJobId_fkey"
  FOREIGN KEY ("sourceMemoryJobId") REFERENCES "MemoryJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "MemoryChange" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "threadId" TEXT NOT NULL REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "jobId" TEXT REFERENCES "MemoryJob"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "subject" TEXT NOT NULL, "key" TEXT NOT NULL, "op" TEXT NOT NULL,
  "before" JSONB, "after" JSONB NOT NULL, "actor" TEXT NOT NULL, "seq" INTEGER NOT NULL,
  "invalidated" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MemoryChange_threadId_subject_key_seq_idx" ON "MemoryChange"("threadId", "subject", "key", "seq");
CREATE INDEX "MemoryChange_jobId_idx" ON "MemoryChange"("jobId");
