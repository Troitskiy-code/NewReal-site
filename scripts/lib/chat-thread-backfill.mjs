// Idempotent completion of the ChatThread migration, safe to re-run at any time.
// Each step commits on its own; Message rows are assigned in short batches so the table is never
// locked for long. A row is always attached to the default (most recent) story of its pair, the
// same rule the flag-off read uses; pairs without a story get one, numbered after existing ones.

const STORY = `SELECT DISTINCT ON ("userId", "characterId") "id", "userId", "characterId" FROM "ChatThread"
  ORDER BY "userId", "characterId", "lastMessageAt" DESC, "createdAt" DESC, "id" DESC`;

const TABLES = ['Message', 'Memory', 'CoreMemory', 'EpisodicMemory', 'MemoryEntry'];

export async function countUnassigned(client) {
  const counts = {};
  for (const table of TABLES) {
    const { rows } = await client.query(`SELECT COUNT(*)::int AS count FROM "${table}" WHERE "threadId" IS NULL`);
    counts[table] = rows[0].count;
  }
  return counts;
}

async function createMissingStories(client) {
  const { rowCount } = await client.query(`
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
    WHERE NOT EXISTS (SELECT 1 FROM "ChatThread" existing WHERE existing."userId" = pair."userId" AND existing."characterId" = pair."characterId")`);
  return rowCount;
}

/** Summary/core are unique per story: only the newest unassigned row may join a story that has none. */
async function attachUniqueMemory(client, table, timeColumn) {
  const { rowCount } = await client.query(`
    WITH story AS (${STORY})
    UPDATE "${table}" target SET "threadId" = story."id" FROM story
    WHERE target."threadId" IS NULL AND story."userId" = target."userId" AND story."characterId" = target."characterId"
      AND NOT EXISTS (SELECT 1 FROM "${table}" taken WHERE taken."threadId" = story."id")
      AND target."id" = (SELECT newest."id" FROM "${table}" newest
        WHERE newest."userId" = target."userId" AND newest."characterId" = target."characterId" AND newest."threadId" IS NULL
        ORDER BY newest."${timeColumn}" DESC, newest."id" DESC LIMIT 1)`);
  return rowCount;
}

async function attachInBatches(client, table, batchSize, touched) {
  let total = 0;
  for (;;) {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query(`
        WITH batch AS (
          SELECT "id", "userId", "characterId" FROM "${table}" WHERE "threadId" IS NULL
          ORDER BY "id" LIMIT $1 FOR UPDATE SKIP LOCKED
        ), story AS (
          SELECT DISTINCT ON (t."userId", t."characterId") t."id", t."userId", t."characterId"
          FROM "ChatThread" t JOIN (SELECT DISTINCT "userId", "characterId" FROM batch) pair
            ON pair."userId" = t."userId" AND pair."characterId" = t."characterId"
          ORDER BY t."userId", t."characterId", t."lastMessageAt" DESC, t."createdAt" DESC, t."id" DESC
        )
        UPDATE "${table}" target SET "threadId" = story."id"
        FROM batch JOIN story ON story."userId" = batch."userId" AND story."characterId" = batch."characterId"
        WHERE target."id" = batch."id"
        RETURNING target."threadId"`, [batchSize]);
      await client.query('COMMIT');
      for (const row of rows) touched?.add(row.threadId);
      total += rows.length;
      // Nothing assignable in this batch (no story for these pairs): stop instead of spinning.
      if (rows.length === 0) return total;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }
}

export async function backfillChatThreads(client, { batchSize = 5000, log = () => {} } = {}) {
  const result = { storiesCreated: 0, assigned: {}, storiesTouched: 0 };
  result.storiesCreated = await createMissingStories(client);
  log(`stories created: ${result.storiesCreated}`);
  result.assigned.Memory = await attachUniqueMemory(client, 'Memory', 'createdAt');
  result.assigned.CoreMemory = await attachUniqueMemory(client, 'CoreMemory', 'updatedAt');
  for (const table of ['EpisodicMemory', 'MemoryEntry']) {
    result.assigned[table] = await attachInBatches(client, table, batchSize);
  }
  const touched = new Set();
  result.assigned.Message = await attachInBatches(client, 'Message', batchSize, touched);
  log(`assigned: ${JSON.stringify(result.assigned)}`);
  // Rows written by the previous code during deployment can be newer than the story's last activity.
  if (touched.size) {
    const { rowCount } = await client.query(`
      UPDATE "ChatThread" t SET "lastMessageAt" = latest."at", "updatedAt" = CURRENT_TIMESTAMP
      FROM (SELECT "threadId", MAX("createdAt") AS "at" FROM "Message" WHERE "threadId" = ANY($1::text[]) GROUP BY 1) latest
      WHERE t."id" = latest."threadId" AND latest."at" > t."lastMessageAt"`, [[...touched]]);
    result.storiesTouched = rowCount;
  }
  result.remaining = await countUnassigned(client);
  return result;
}
