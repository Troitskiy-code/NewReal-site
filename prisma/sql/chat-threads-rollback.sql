-- LAST RESORT, NOT the normal rollback. The normal rollback is CHAT_THREADS_ENABLED=0 (no schema change).
-- Use only when the application code itself must go back to the version before ChatThread, after a
-- verified backup. It restores the (userId, characterId) uniqueness that the previous code relies on.
--
-- Kept: every message (the previous code shows all stories of a pair as one chat), stories, threadId
-- columns (ignored by the previous code, a later redeploy re-runs scripts/backfill-chat-threads.mjs).
-- Lost: summary, core, episodes and memory entries of every story except the most recent one per
-- user+character (the previous code would otherwise mix them), and those stories' prompt state.
-- The previous build must keep prisma/migrations/20261012230000_chat_threads in its migrations folder,
-- or must not run `prisma migrate deploy`, because this migration stays recorded as applied.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

CREATE TEMP TABLE keep_story ON COMMIT DROP AS
  SELECT DISTINCT ON ("userId", "characterId") "id", "userId", "characterId" FROM "ChatThread"
  ORDER BY "userId", "characterId", "lastMessageAt" DESC, "createdAt" DESC, "id" DESC;

DELETE FROM "Memory" WHERE "threadId" IS NOT NULL AND "threadId" NOT IN (SELECT "id" FROM keep_story);
DELETE FROM "CoreMemory" WHERE "threadId" IS NOT NULL AND "threadId" NOT IN (SELECT "id" FROM keep_story);
DELETE FROM "EpisodicMemory" WHERE "threadId" IS NOT NULL AND "threadId" NOT IN (SELECT "id" FROM keep_story);
DELETE FROM "MemoryEntry" WHERE "threadId" IS NOT NULL AND "threadId" NOT IN (SELECT "id" FROM keep_story);
DELETE FROM "ChatPromptState" WHERE "scopeKey" LIKE 'thread:%'
  AND substring("scopeKey" FROM 8) NOT IN (SELECT "id" FROM keep_story);

-- A row written without a story (previous code during the window) may duplicate the kept one: keep the newest.
DELETE FROM "Memory" older USING "Memory" newer
  WHERE older."userId" = newer."userId" AND older."characterId" = newer."characterId"
    AND (older."createdAt", older."id") < (newer."createdAt", newer."id");
DELETE FROM "CoreMemory" older USING "CoreMemory" newer
  WHERE older."userId" = newer."userId" AND older."characterId" = newer."characterId"
    AND (older."updatedAt", older."id") < (newer."updatedAt", newer."id");

-- The previous code reads "user:<id>" prompt state, restore it from the kept story where missing.
INSERT INTO "ChatPromptState" ("id", "scopeKey", "characterId", "builderVersion", "mode", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'user:' || story."userId", state."characterId", state."builderVersion", state."mode", state."createdAt", CURRENT_TIMESTAMP
FROM keep_story story
JOIN "ChatPromptState" state ON state."scopeKey" = 'thread:' || story."id" AND state."characterId" = story."characterId"
ON CONFLICT ("scopeKey", "characterId") DO NOTHING;

DROP INDEX IF EXISTS "Memory_userId_characterId_idx";
DROP INDEX IF EXISTS "CoreMemory_userId_characterId_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "Memory_userId_characterId_key" ON "Memory"("userId", "characterId");
CREATE UNIQUE INDEX IF NOT EXISTS "CoreMemory_userId_characterId_key" ON "CoreMemory"("userId", "characterId");
COMMIT;
