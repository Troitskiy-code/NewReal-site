-- ChatThread backfill as plain SQL, for an SQL console (Adminer) where the Node script cannot run.
-- Same rules as scripts/lib/chat-thread-backfill.mjs, idempotent, safe to run again at any time.
-- Messages are updated in one statement: use this file for small tables (production had ~19k
-- messages on 2026-10-12), for large tables run `npm run chat-threads:backfill`, which works in batches.
-- Run inside BEGIN ... COMMIT, the final SELECT must show zero in every column.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

INSERT INTO "ChatThread" ("id", "userId", "characterId", "personaId", "number", "title", "status", "createdAt", "updatedAt", "lastMessageAt")
SELECT gen_random_uuid()::text, pair."userId", pair."characterId", selection."personaId", 1, NULL, 'active',
  pair."firstAt", CURRENT_TIMESTAMP, pair."lastAt"
FROM (
  SELECT "userId", "characterId", MIN("firstAt") AS "firstAt", COALESCE(MAX("messageAt"), MAX("lastAt")) AS "lastAt" FROM (
    SELECT "userId", "characterId", MIN("createdAt") AS "firstAt", MAX("createdAt") AS "lastAt", MAX("createdAt") AS "messageAt" FROM "Message" WHERE "threadId" IS NULL GROUP BY 1, 2
    UNION ALL SELECT "userId", "characterId", "createdAt", "createdAt", NULL FROM "Memory" WHERE "threadId" IS NULL
    UNION ALL SELECT "userId", "characterId", "updatedAt", "updatedAt", NULL FROM "CoreMemory" WHERE "threadId" IS NULL
    UNION ALL SELECT "userId", "characterId", MIN("timestamp"), MAX("timestamp"), NULL FROM "EpisodicMemory" WHERE "threadId" IS NULL GROUP BY 1, 2
    UNION ALL SELECT "userId", "characterId", MIN("createdAt"), MAX("createdAt"), NULL FROM "MemoryEntry" WHERE "threadId" IS NULL GROUP BY 1, 2
  ) source GROUP BY 1, 2
) pair
LEFT JOIN "PersonaSelection" selection ON selection."userId" = pair."userId" AND selection."characterId" = pair."characterId"
WHERE NOT EXISTS (SELECT 1 FROM "ChatThread" existing WHERE existing."userId" = pair."userId" AND existing."characterId" = pair."characterId");

CREATE TEMP TABLE chat_thread_default ON COMMIT DROP AS
  SELECT DISTINCT ON ("userId", "characterId") "id", "userId", "characterId" FROM "ChatThread"
  ORDER BY "userId", "characterId", "lastMessageAt" DESC, "createdAt" DESC, "id" DESC;

UPDATE "Memory" target SET "threadId" = story."id" FROM chat_thread_default story
WHERE target."threadId" IS NULL AND story."userId" = target."userId" AND story."characterId" = target."characterId"
  AND NOT EXISTS (SELECT 1 FROM "Memory" taken WHERE taken."threadId" = story."id")
  AND target."id" = (SELECT newest."id" FROM "Memory" newest
    WHERE newest."userId" = target."userId" AND newest."characterId" = target."characterId" AND newest."threadId" IS NULL
    ORDER BY newest."createdAt" DESC, newest."id" DESC LIMIT 1);

UPDATE "CoreMemory" target SET "threadId" = story."id" FROM chat_thread_default story
WHERE target."threadId" IS NULL AND story."userId" = target."userId" AND story."characterId" = target."characterId"
  AND NOT EXISTS (SELECT 1 FROM "CoreMemory" taken WHERE taken."threadId" = story."id")
  AND target."id" = (SELECT newest."id" FROM "CoreMemory" newest
    WHERE newest."userId" = target."userId" AND newest."characterId" = target."characterId" AND newest."threadId" IS NULL
    ORDER BY newest."updatedAt" DESC, newest."id" DESC LIMIT 1);

UPDATE "EpisodicMemory" target SET "threadId" = story."id" FROM chat_thread_default story
WHERE target."threadId" IS NULL AND story."userId" = target."userId" AND story."characterId" = target."characterId";

UPDATE "MemoryEntry" target SET "threadId" = story."id" FROM chat_thread_default story
WHERE target."threadId" IS NULL AND story."userId" = target."userId" AND story."characterId" = target."characterId";

CREATE TEMP TABLE chat_thread_touched ON COMMIT DROP AS SELECT DISTINCT story."id" FROM chat_thread_default story
  JOIN "Message" m ON m."userId" = story."userId" AND m."characterId" = story."characterId" AND m."threadId" IS NULL;

UPDATE "Message" target SET "threadId" = story."id" FROM chat_thread_default story
WHERE target."threadId" IS NULL AND story."userId" = target."userId" AND story."characterId" = target."characterId";

-- Rows written by the previous code during deployment can be newer than the story's last activity.
UPDATE "ChatThread" t SET "lastMessageAt" = latest."at", "updatedAt" = CURRENT_TIMESTAMP
FROM (SELECT "threadId", MAX("createdAt") AS "at" FROM "Message" WHERE "threadId" IN (SELECT "id" FROM chat_thread_touched) GROUP BY 1) latest
WHERE t."id" = latest."threadId" AND latest."at" > t."lastMessageAt";

SELECT
  (SELECT COUNT(*) FROM "Message" WHERE "threadId" IS NULL) AS "messagesWithoutStory",
  (SELECT COUNT(*) FROM "Memory" WHERE "threadId" IS NULL) AS "summariesWithoutStory",
  (SELECT COUNT(*) FROM "CoreMemory" WHERE "threadId" IS NULL) AS "coreWithoutStory",
  (SELECT COUNT(*) FROM "EpisodicMemory" WHERE "threadId" IS NULL) AS "episodesWithoutStory",
  (SELECT COUNT(*) FROM "MemoryEntry" WHERE "threadId" IS NULL) AS "entriesWithoutStory";
