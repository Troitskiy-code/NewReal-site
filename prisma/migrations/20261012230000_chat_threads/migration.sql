-- Independent stories (ChatThread). Additive and safe to execute again: every step is guarded.
-- Order: schema -> one default story per user+character -> memory rows get its id ->
-- only then the memory uniqueness moves from (userId, characterId) to threadId.
-- "Message"."threadId" is filled in batches afterwards by scripts/backfill-chat-threads.mjs,
-- until then CHAT_THREADS_ENABLED stays off and the legacy read also includes unassigned rows.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

CREATE TABLE IF NOT EXISTS "ChatThread" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "personaId" TEXT,
  "number" INTEGER NOT NULL DEFAULT 1,
  "title" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ChatThread_userId_characterId_status_lastMessageAt_idx"
  ON "ChatThread"("userId", "characterId", "status", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "ChatThread_userId_lastMessageAt_idx" ON "ChatThread"("userId", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "ChatThread_personaId_idx" ON "ChatThread"("personaId");

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "threadId" TEXT;
ALTER TABLE "Memory" ADD COLUMN IF NOT EXISTS "threadId" TEXT;
ALTER TABLE "CoreMemory" ADD COLUMN IF NOT EXISTS "threadId" TEXT;
ALTER TABLE "EpisodicMemory" ADD COLUMN IF NOT EXISTS "threadId" TEXT;
ALTER TABLE "MemoryEntry" ADD COLUMN IF NOT EXISTS "threadId" TEXT;
ALTER TABLE "AiCostEvent" ADD COLUMN IF NOT EXISTS "threadHash" TEXT;

-- Built while every value is NULL, the batched backfill then maintains it.
CREATE INDEX IF NOT EXISTS "Message_threadId_createdAt_idx" ON "Message"("threadId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "Memory_threadId_key" ON "Memory"("threadId");
CREATE UNIQUE INDEX IF NOT EXISTS "CoreMemory_threadId_key" ON "CoreMemory"("threadId");
CREATE INDEX IF NOT EXISTS "EpisodicMemory_threadId_timestamp_idx" ON "EpisodicMemory"("threadId", "timestamp");
CREATE INDEX IF NOT EXISTS "MemoryEntry_threadId_type_idx" ON "MemoryEntry"("threadId", "type");

-- Plain statements (no DO block), so an SQL console that splits on semicolons runs the file unchanged.
-- Dropping and re-adding keeps a repeated run idempotent, validation of these keys is cheap.
ALTER TABLE "ChatThread" DROP CONSTRAINT IF EXISTS "ChatThread_userId_fkey";
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatThread" DROP CONSTRAINT IF EXISTS "ChatThread_characterId_fkey";
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatThread" DROP CONSTRAINT IF EXISTS "ChatThread_personaId_fkey";
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_threadId_fkey";
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Memory" DROP CONSTRAINT IF EXISTS "Memory_threadId_fkey";
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoreMemory" DROP CONSTRAINT IF EXISTS "CoreMemory_threadId_fkey";
ALTER TABLE "CoreMemory" ADD CONSTRAINT "CoreMemory_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EpisodicMemory" DROP CONSTRAINT IF EXISTS "EpisodicMemory_threadId_fkey";
ALTER TABLE "EpisodicMemory" ADD CONSTRAINT "EpisodicMemory_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemoryEntry" DROP CONSTRAINT IF EXISTS "MemoryEntry_threadId_fkey";
ALTER TABLE "MemoryEntry" ADD CONSTRAINT "MemoryEntry_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One default story for every user+character pair that has messages or memory and no story yet.
-- The persona selected for the pair becomes the persona of that story. Its activity time is the
-- last message, memory timestamps are used only for a pair that has memory but no messages.
INSERT INTO "ChatThread" ("id", "userId", "characterId", "personaId", "number", "title", "status", "createdAt", "updatedAt", "lastMessageAt")
SELECT gen_random_uuid()::text, pair."userId", pair."characterId", selection."personaId", 1, NULL, 'active',
  pair."firstAt", CURRENT_TIMESTAMP, pair."lastAt"
FROM (
  SELECT "userId", "characterId", MIN("firstAt") AS "firstAt", COALESCE(MAX("messageAt"), MAX("lastAt")) AS "lastAt" FROM (
    SELECT "userId", "characterId", MIN("createdAt") AS "firstAt", MAX("createdAt") AS "lastAt", MAX("createdAt") AS "messageAt" FROM "Message" GROUP BY 1, 2
    UNION ALL SELECT "userId", "characterId", "createdAt", "createdAt", NULL FROM "Memory"
    UNION ALL SELECT "userId", "characterId", "updatedAt", "updatedAt", NULL FROM "CoreMemory"
    UNION ALL SELECT "userId", "characterId", MIN("timestamp"), MAX("timestamp"), NULL FROM "EpisodicMemory" GROUP BY 1, 2
    UNION ALL SELECT "userId", "characterId", MIN("createdAt"), MAX("createdAt"), NULL FROM "MemoryEntry" GROUP BY 1, 2
  ) source GROUP BY 1, 2
) pair
LEFT JOIN "PersonaSelection" selection
  ON selection."userId" = pair."userId" AND selection."characterId" = pair."characterId"
WHERE NOT EXISTS (
  SELECT 1 FROM "ChatThread" existing WHERE existing."userId" = pair."userId" AND existing."characterId" = pair."characterId"
);

-- Memory tables are bounded per pair, one statement each. The default story is the most recent one,
-- the same rule the legacy (flag off) read uses. Only the newest unassigned summary/core row is attached.
WITH story AS (
  SELECT DISTINCT ON ("userId", "characterId") "id", "userId", "characterId" FROM "ChatThread"
  ORDER BY "userId", "characterId", "lastMessageAt" DESC, "createdAt" DESC, "id" DESC
)
UPDATE "Memory" target SET "threadId" = story."id" FROM story
WHERE target."threadId" IS NULL AND story."userId" = target."userId" AND story."characterId" = target."characterId"
  AND NOT EXISTS (SELECT 1 FROM "Memory" taken WHERE taken."threadId" = story."id")
  AND target."id" = (SELECT newest."id" FROM "Memory" newest
    WHERE newest."userId" = target."userId" AND newest."characterId" = target."characterId" AND newest."threadId" IS NULL
    ORDER BY newest."createdAt" DESC, newest."id" DESC LIMIT 1);

WITH story AS (
  SELECT DISTINCT ON ("userId", "characterId") "id", "userId", "characterId" FROM "ChatThread"
  ORDER BY "userId", "characterId", "lastMessageAt" DESC, "createdAt" DESC, "id" DESC
)
UPDATE "CoreMemory" target SET "threadId" = story."id" FROM story
WHERE target."threadId" IS NULL AND story."userId" = target."userId" AND story."characterId" = target."characterId"
  AND NOT EXISTS (SELECT 1 FROM "CoreMemory" taken WHERE taken."threadId" = story."id")
  AND target."id" = (SELECT newest."id" FROM "CoreMemory" newest
    WHERE newest."userId" = target."userId" AND newest."characterId" = target."characterId" AND newest."threadId" IS NULL
    ORDER BY newest."updatedAt" DESC, newest."id" DESC LIMIT 1);

WITH story AS (
  SELECT DISTINCT ON ("userId", "characterId") "id", "userId", "characterId" FROM "ChatThread"
  ORDER BY "userId", "characterId", "lastMessageAt" DESC, "createdAt" DESC, "id" DESC
)
UPDATE "EpisodicMemory" target SET "threadId" = story."id" FROM story
WHERE target."threadId" IS NULL AND story."userId" = target."userId" AND story."characterId" = target."characterId";

WITH story AS (
  SELECT DISTINCT ON ("userId", "characterId") "id", "userId", "characterId" FROM "ChatThread"
  ORDER BY "userId", "characterId", "lastMessageAt" DESC, "createdAt" DESC, "id" DESC
)
UPDATE "MemoryEntry" target SET "threadId" = story."id" FROM story
WHERE target."threadId" IS NULL AND story."userId" = target."userId" AND story."characterId" = target."characterId";

-- The pinned prompt builder/mode of the old chat moves with it, "user:" rows stay for a code rollback.
-- A bulk prompt conversion (20261012193000_prompt_bulk_rollout) marks the state and keeps a rollback
-- snapshot per scope key, both move with the story so an admin rollback also restores it.
INSERT INTO "ChatPromptState" ("id", "scopeKey", "characterId", "builderVersion", "mode", "promptMigrationId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'thread:' || story."id", state."characterId", state."builderVersion", state."mode",
  state."promptMigrationId", state."createdAt", CURRENT_TIMESTAMP
FROM "ChatThread" story
JOIN "ChatPromptState" state ON state."scopeKey" = 'user:' || story."userId" AND state."characterId" = story."characterId"
WHERE story."number" = 1
ON CONFLICT ("scopeKey", "characterId") DO NOTHING;

INSERT INTO "PromptMigrationStory" ("id", "entryId", "scopeKey", "builderVersion", "mode", "previousMigrationId")
SELECT gen_random_uuid()::text, snapshot."entryId", 'thread:' || story."id", snapshot."builderVersion", snapshot."mode", snapshot."previousMigrationId"
FROM "ChatThread" story
JOIN "PromptMigrationEntry" entry ON entry."characterId" = story."characterId"
JOIN "PromptMigrationStory" snapshot ON snapshot."entryId" = entry."id" AND snapshot."scopeKey" = 'user:' || story."userId"
WHERE story."number" = 1
ON CONFLICT ("entryId", "scopeKey") DO NOTHING;

-- Uniqueness moves only now, after every existing summary/core row has its story.
DROP INDEX IF EXISTS "Memory_userId_characterId_key";
DROP INDEX IF EXISTS "CoreMemory_userId_characterId_key";
CREATE INDEX IF NOT EXISTS "Memory_userId_characterId_idx" ON "Memory"("userId", "characterId");
CREATE INDEX IF NOT EXISTS "CoreMemory_userId_characterId_idx" ON "CoreMemory"("userId", "characterId");
