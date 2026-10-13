// Independent stories (ChatThread): migration on synthetic data and acceptance scenarios.
// Isolated: embedded PostgreSQL (GUEST_TEST_RUNTIME), PGlite for vector SQL, fake AI and embeddings.
// Never loads .env, never touches DATABASE_URL of a real environment, never calls providers.
// Run: npm run verify:chat-threads
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { startHarness } from './lib/memory-test-harness.mjs';
import { backfillChatThreads, countUnassigned } from './lib/chat-thread-backfill.mjs';

const require = createRequire(import.meta.url);
const { NextRequest } = require('next/server');
const MIGRATION = '20261012230000_chat_threads';

let passed = 0;
const check = (name, condition, details) => {
  if (!condition) {
    console.error(`FAIL ${name}${details === undefined ? '' : ` ${JSON.stringify(details)}`}`);
    throw new Error(`Check failed: ${name}`);
  }
  passed += 1;
  console.log(`PASS ${name}`);
};

// Mutation runs prove the checks can fail: each one removes one isolation rule and must FAIL.
// CHAT_THREADS_MUTATION=rag|history|memory|persona (application part only).
const MUTATIONS = {
  rag: ['src/lib/messageEmbeddings.ts', (source) => source.replaceAll(/AND \(m\."threadId" = \$\{threadId\} OR \(\$\{legacy\}::boolean AND m\."threadId" IS NULL\)\)/g, '')],
  history: ['src/lib/chatThreads.ts', (source) => source.replace(': { userId, characterId, threadId };', ': { userId, characterId };')],
  memory: ['src/lib/chatThreads.ts', (source) => source.replace('return { userId: scope.userId, characterId: scope.characterId, threadId: scope.threadId };',
    'return { userId: scope.userId, characterId: scope.characterId };')],
  persona: ['src/lib/personaService.ts', (source) => source.replace('const persona = threadId', 'const persona = false')],
};
const mutation = process.env['CHAT_THREADS_MUTATION'] ?? '';
if (mutation && !MUTATIONS[mutation]) throw new Error('Unknown CHAT_THREADS_MUTATION');
const h = await startHarness({
  label: 'chat-threads',
  sourceTransform: (file, source) => {
    if (!mutation) return source;
    const [target, apply] = MUTATIONS[mutation];
    if (!file.replaceAll('\\', '/').endsWith(target)) return source;
    const changed = apply(source);
    if (changed === source) throw new Error(`Mutation ${mutation} did not apply`);
    return changed;
  },
});
const { db, provider, helpers, load, root, session } = h;
const migrationUrl = h.databaseUrl.replace(/\/nv_memory_test$/, '/nv_threads_migration');
const ddl = new pg.Client({ connectionString: migrationUrl });

function migrationSql(name) {
  return readFileSync(join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8')
    .replace('CREATE EXTENSION IF NOT EXISTS vector;', '-- pgvector omitted only in this disposable fixture')
    .replace(/vector\(\d+\)/g, 'BYTEA')
    .replace(/CREATE INDEX "MessageEmbeddingDeepinfra_embedding_hnsw_idx"[\s\S]*?;/g, '-- pgvector index omitted');
}

async function rows(sql, params = []) { return (await ddl.query(sql, params)).rows; }

// ---------------------------------------------------------------------------------------------
// Part A. Migration and batched backfill on a copy built from the real migration chain.
// ---------------------------------------------------------------------------------------------
async function migrationPart() {
  const admin = new pg.Client({ connectionString: h.databaseUrl.replace(/\/nv_memory_test$/, '/postgres') });
  await admin.connect();
  await admin.query('CREATE DATABASE nv_threads_migration');
  await admin.end();
  await ddl.connect();
  await ddl.query("SET TIME ZONE 'UTC'");
  const names = readdirSync(join(root, 'prisma/migrations')).filter((name) => /^\d+_/.test(name)).sort();
  check('migration is the newest in the chain', names.at(-1) === MIGRATION, names.at(-1));
  for (const name of names.filter((name) => name < MIGRATION)) await ddl.query(migrationSql(name));

  // Synthetic production-like data: 4 users, 3 characters, every kind of row.
  const t0 = Date.parse('2026-09-01T10:00:00Z');
  const at = (minutes) => new Date(t0 + minutes * 60_000);
  for (const id of ['u1', 'u2', 'u3', 'u4']) await ddl.query('INSERT INTO "User" ("id", "email") VALUES ($1, $2)', [id, `${id}@example.test`]);
  for (const id of ['c1', 'c2', 'c3']) await ddl.query('INSERT INTO "Character" ("id", "name", "userId", "updatedAt", "isPublic") VALUES ($1, $2, $3, NOW(), true)', [id, `Персонаж ${id}`, 'u1']);
  await ddl.query(`INSERT INTO "Persona" ("id", "userId", "name", "updatedAt") VALUES ('p1', 'u1', 'Лео', NOW()), ('p2', 'u2', 'Мира', NOW()), ('p4', 'u4', 'Тень', NOW())`);
  await ddl.query(`INSERT INTO "PersonaSelection" ("id", "userId", "characterId", "personaId") VALUES
    ('s1', 'u1', 'c1', 'p1'), ('s2', 'u2', 'c2', 'p2'), ('s4', 'u4', 'c3', 'p4')`);
  const plan = { 'u1:c1': 37, 'u1:c2': 12, 'u2:c1': 23, 'u4:c3': 9 };
  let n = 0;
  for (const [pair, count] of Object.entries(plan)) {
    const [userId, characterId] = pair.split(':');
    for (let i = 0; i < count; i += 1) {
      n += 1;
      await ddl.query('INSERT INTO "Message" ("id", "characterId", "chatId", "userId", "role", "content", "createdAt") VALUES ($1, $2, $2, $3, $4, $5, $6)',
        [`m${String(n).padStart(4, '0')}`, characterId, userId, i % 2 ? 'assistant' : 'user', `${pair} сообщение ${i}`, at(n)]);
    }
  }
  // Embeddings of some messages; they must survive untouched.
  await ddl.query(`INSERT INTO "MessageEmbedding" ("id", "messageId", "embedding") SELECT 'e' || "id", "id", '\\x00'::bytea FROM "Message" WHERE "id" < 'm0020'`);
  await ddl.query(`INSERT INTO "MessageEmbeddingDeepinfra" ("id", "messageId", "embedding") SELECT 'd' || "id", "id", '\\x01'::bytea FROM "Message" WHERE "id" < 'm0010'`);
  // Memory: u1:c1 full, u2:c1 summary only, u3:c2 core/episodes without any messages, u4:c3 entries.
  await ddl.query(`INSERT INTO "Memory" ("id", "characterId", "userId", "summary", "lastSummarizedAt", "summarizedMessageCount") VALUES
    ('mem1', 'c1', 'u1', 'Сводка u1:c1', $1, 20), ('mem2', 'c1', 'u2', 'Сводка u2:c1', $1, 10)`, [at(20)]);
  await ddl.query(`INSERT INTO "CoreMemory" ("id", "userId", "characterId", "content", "updatedAt") VALUES
    ('core1', 'u1', 'c1', 'Ядро u1:c1', $1), ('core3', 'u3', 'c2', 'Ядро u3:c2 без сообщений', $2)`, [at(30), at(500)]);
  for (let i = 0; i < 7; i += 1) {
    await ddl.query('INSERT INTO "EpisodicMemory" ("id", "userId", "characterId", "event", "timestamp", "importance") VALUES ($1, $2, $3, $4, $5, 3)',
      [`ep${i}`, i < 5 ? 'u1' : 'u3', i < 5 ? 'c1' : 'c2', `Событие ${i}`, at(i)]);
  }
  await ddl.query(`INSERT INTO "MemoryEntry" ("id", "userId", "characterId", "type", "content") VALUES
    ('me1', 'u1', 'c1', 'summary', 'Сводка u1:c1'), ('me2', 'u1', 'c1', 'core', 'Ядро u1:c1'), ('me3', 'u4', 'c3', 'episodic', 'Событие u4')`);
  await ddl.query(`INSERT INTO "ChatPromptState" ("id", "scopeKey", "characterId", "builderVersion", "mode", "updatedAt") VALUES
    ('ps1', 'user:u1', 'c1', 2, 'gm', NOW()), ('ps2', 'user:u2', 'c1', 1, 'character', NOW()), ('ps3', 'guest:g1', 'c1', 2, 'character', NOW())`);
  await ddl.query(`INSERT INTO "AiCostEvent" ("id", "operationId", "provider", "model", "purpose", "attempt", "outcome", "costSource")
    VALUES ('cost1', 'op1', 'kodikrouter', 'test/model', 'chat', 1, 'completed', 'provider')`);
  // An applied bulk prompt conversion of c1 with a rollback snapshot for the old pair key.
  await ddl.query(`INSERT INTO "PromptMigrationEntry" ("id", "characterId", "status", "sourceFingerprint", "before", "proposal")
    VALUES ('pme1', 'c1', 'applied', 'fp', '{"promptBuilderVersion":1,"roleplayMode":"character"}', '{"roleplayMode":"gm"}')`);
  await ddl.query(`UPDATE "ChatPromptState" SET "promptMigrationId" = 'pme1' WHERE "id" = 'ps1'`);
  await ddl.query(`INSERT INTO "PromptMigrationStory" ("id", "entryId", "scopeKey", "builderVersion", "mode") VALUES ('pms1', 'pme1', 'user:u1', 1, 'character')`);

  const before = {
    messages: await rows('SELECT "id", "userId", "characterId", "content", "createdAt" FROM "Message" ORDER BY "id"'),
    memory: await rows('SELECT "id", "summary" FROM "Memory" ORDER BY "id"'),
    core: await rows('SELECT "id", "content" FROM "CoreMemory" ORDER BY "id"'),
    episodic: await rows('SELECT "id", "event" FROM "EpisodicMemory" ORDER BY "id"'),
    entries: await rows('SELECT "id", "content" FROM "MemoryEntry" ORDER BY "id"'),
    embeddings: await rows('SELECT "id", "messageId" FROM "MessageEmbedding" UNION ALL SELECT "id", "messageId" FROM "MessageEmbeddingDeepinfra" ORDER BY 1'),
  };
  const expectedPairs = ['u1:c1', 'u1:c2', 'u2:c1', 'u3:c2', 'u4:c3'];

  await ddl.query(migrationSql(MIGRATION));
  const first = await backfillChatThreads(ddl, { batchSize: 7 });
  check('backfill assigned every legacy message in batches', first.assigned.Message === before.messages.length && Object.values(first.remaining).every((count) => count === 0), first);

  const threads = await rows('SELECT * FROM "ChatThread" ORDER BY "userId", "characterId"');
  const pairs = threads.map((thread) => `${thread.userId}:${thread.characterId}`);
  check('every pair with messages or memory got exactly one default story', JSON.stringify(pairs) === JSON.stringify(expectedPairs), pairs);
  check('a pair with only a persona choice gets no story', !pairs.includes('u2:c2'));
  check('default stories are number 1, active and untitled', threads.every((thread) => thread.number === 1 && thread.status === 'active' && thread.title === null));
  const byPair = Object.fromEntries(threads.map((thread) => [`${thread.userId}:${thread.characterId}`, thread]));
  check('the pair persona becomes the persona of its story', byPair['u1:c1'].personaId === 'p1' && byPair['u4:c3'].personaId === 'p4' && byPair['u2:c1'].personaId === null);
  const lastMessage = await rows('SELECT "userId" || \':\' || "characterId" AS pair, MAX("createdAt") AS at FROM "Message" GROUP BY 1');
  check('story activity is the last message time', lastMessage.every((row) => byPair[row.pair].lastMessageAt.getTime() === row.at.getTime()));

  const after = await rows('SELECT "id", "userId", "characterId", "content", "createdAt", "threadId" FROM "Message" ORDER BY "id"');
  check('no message is lost, duplicated or changed', JSON.stringify(after.map(({ threadId, ...row }) => row)) === JSON.stringify(before.messages));
  check('every message belongs to the story of its own pair', after.every((row) => row.threadId === byPair[`${row.userId}:${row.characterId}`].id));
  for (const [table, key, snapshot] of [['Memory', 'summary', before.memory], ['CoreMemory', 'content', before.core], ['EpisodicMemory', 'event', before.episodic], ['MemoryEntry', 'content', before.entries]]) {
    const current = await rows(`SELECT "id", "${key}", "userId", "characterId", "threadId" FROM "${table}" ORDER BY "id"`);
    check(`${table}: no row lost or changed`, JSON.stringify(current.map((row) => ({ id: row.id, [key]: row[key] }))) === JSON.stringify(snapshot));
    check(`${table}: every row belongs to its pair story`, current.every((row) => row.threadId === byPair[`${row.userId}:${row.characterId}`].id));
  }
  check('embeddings survive untouched', JSON.stringify(await rows('SELECT "id", "messageId" FROM "MessageEmbedding" UNION ALL SELECT "id", "messageId" FROM "MessageEmbeddingDeepinfra" ORDER BY 1')) === JSON.stringify(before.embeddings));
  const states = await rows('SELECT "scopeKey", "characterId", "builderVersion", "mode" FROM "ChatPromptState" ORDER BY "scopeKey"');
  check('pinned prompt state moves to the story and the old key stays for a code rollback',
    states.some((row) => row.scopeKey === `thread:${byPair['u1:c1'].id}` && row.builderVersion === 2 && row.mode === 'gm')
    && states.some((row) => row.scopeKey === `thread:${byPair['u2:c1'].id}` && row.builderVersion === 1)
    && states.some((row) => row.scopeKey === 'user:u1') && states.length === 5, states);
  const moved = await rows(`SELECT s."promptMigrationId", snapshot."builderVersion", snapshot."mode" FROM "ChatPromptState" s
    JOIN "PromptMigrationStory" snapshot ON snapshot."entryId" = s."promptMigrationId" AND snapshot."scopeKey" = s."scopeKey"
    WHERE s."scopeKey" = $1`, [`thread:${byPair['u1:c1'].id}`]);
  check('a bulk prompt conversion mark and its rollback snapshot move with the story',
    moved.length === 1 && moved[0].promptMigrationId === 'pme1' && moved[0].builderVersion === 1 && moved[0].mode === 'character', moved);
  const indexes = (await rows("SELECT indexname FROM pg_indexes WHERE tablename IN ('Memory', 'CoreMemory')")).map((row) => row.indexname);
  check('memory uniqueness moved from the pair to the story',
    !indexes.includes('Memory_userId_characterId_key') && indexes.includes('Memory_threadId_key')
    && !indexes.includes('CoreMemory_userId_characterId_key') && indexes.includes('CoreMemory_threadId_key'), indexes);

  // Second run of both steps changes nothing.
  const snapshot = async () => JSON.stringify([
    await rows('SELECT "id", "userId", "characterId", "personaId", "number", "status", "lastMessageAt" FROM "ChatThread" ORDER BY "id"'),
    await rows('SELECT "id", "threadId" FROM "Message" ORDER BY "id"'),
    await rows('SELECT "id", "threadId" FROM "Memory" UNION ALL SELECT "id", "threadId" FROM "CoreMemory" UNION ALL SELECT "id", "threadId" FROM "EpisodicMemory" UNION ALL SELECT "id", "threadId" FROM "MemoryEntry" ORDER BY 1'),
    await rows('SELECT "scopeKey", "characterId", "builderVersion", "mode" FROM "ChatPromptState" ORDER BY 1'),
  ]);
  const stable = await snapshot();
  await ddl.query(migrationSql(MIGRATION));
  const second = await backfillChatThreads(ddl, { batchSize: 7 });
  check('re-running the migration and the backfill is a no-op',
    stable === await snapshot() && second.storiesCreated === 0 && Object.values(second.assigned).every((count) => count === 0), second);

  // Unique per story now: a second story of the same pair can have its own summary; one story cannot have two.
  await ddl.query(`INSERT INTO "ChatThread" ("id", "userId", "characterId", "number", "updatedAt", "lastMessageAt") VALUES ('t-extra', 'u1', 'c1', 2, NOW(), $1)`, [at(1)]);
  await ddl.query(`INSERT INTO "Memory" ("id", "characterId", "userId", "threadId", "summary") VALUES ('mem-extra', 'c1', 'u1', 't-extra', 'Другая история')`);
  let duplicate = null;
  try { await ddl.query(`INSERT INTO "Memory" ("id", "characterId", "userId", "threadId", "summary") VALUES ('mem-dup', 'c1', 'u1', 't-extra', 'Дубль')`); } catch (error) { duplicate = error.code; }
  check('a story has at most one summary row (unique threadId)', duplicate === '23505', duplicate);

  // Rows written by the previous code during deployment (threadId NULL) are adopted by a re-run.
  await ddl.query(`INSERT INTO "Message" ("id", "characterId", "chatId", "userId", "role", "content", "createdAt") VALUES
    ('late1', 'c1', 'c1', 'u2', 'user', 'Поздняя реплика старого кода', $1), ('late2', 'c1', 'c1', 'u3', 'user', 'Новая пара во время выкладки', $2)`, [at(900), at(901)]);
  await ddl.query(`INSERT INTO "EpisodicMemory" ("id", "userId", "characterId", "event", "importance") VALUES ('ep-late', 'u2', 'c1', 'Позднее событие', 2)`);
  const late = await backfillChatThreads(ddl, { batchSize: 7 });
  const lateRows = await rows(`SELECT m."id", m."threadId", t."userId", t."characterId", t."lastMessageAt" FROM "Message" m JOIN "ChatThread" t ON t."id" = m."threadId" WHERE m."id" IN ('late1', 'late2') ORDER BY m."id"`);
  check('a re-run adopts rows of the deployment window and creates a story for a new pair',
    late.storiesCreated === 1 && lateRows.length === 2 && lateRows[0].threadId === byPair['u2:c1'].id
    && lateRows[0].lastMessageAt.getTime() === at(900).getTime() && lateRows[1].userId === 'u3' && Object.values(late.remaining).every((count) => count === 0), { late, lateRows });

  // The CLI check mode used before enabling the flag.
  const cli = (args) => spawnSync(process.execPath, [join(root, 'scripts/backfill-chat-threads.mjs'), ...args], {
    cwd: root, env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl }, encoding: 'utf8',
  });
  const checkRun = cli(['--check']);
  check('backfill --check exits 0 when nothing is unassigned', checkRun.status === 0 && JSON.parse(checkRun.stdout).ok === true, checkRun.stdout || checkRun.stderr);
  await ddl.query(`INSERT INTO "Message" ("id", "characterId", "chatId", "userId", "role", "content") VALUES ('late3', 'c2', 'c2', 'u1', 'user', 'Ещё одна поздняя')`);
  const failing = cli(['--check']);
  check('backfill --check exits 1 while a row has no story', failing.status === 1 && JSON.parse(failing.stdout).remaining.Message === 1, failing.stdout);
  const fixed = cli(['--batch-size=2']);
  check('backfill CLI assigns the remaining row', fixed.status === 0 && JSON.parse(fixed.stdout).assigned.Message === 1, fixed.stdout || fixed.stderr);

  // The migrated database matches the Prisma schema (vector columns are BYTEA in both fixtures).
  const schema = join(mkdtempSync(join(tmpdir(), 'nv-threads-schema-')), 'schema.prisma');
  writeFileSync(schema, readFileSync(join(root, 'prisma/schema.prisma'), 'utf8').replace(/Unsupported\("vector\(\d+\)"\)/g, 'Bytes'));
  const diff = spawnSync(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-url', migrationUrl, '--to-schema-datamodel', schema, '--script'], {
    cwd: root, env: { ...process.env, DATABASE_URL: migrationUrl }, encoding: 'utf8',
  });
  const statements = diff.stdout.split('\n').filter((line) => line.trim() && !line.trim().startsWith('--'));
  const ours = statements.filter((line) => /ChatThread|threadId|threadHash|"Memory"|"CoreMemory"|"EpisodicMemory"|"MemoryEntry"/.test(line));
  check('no schema drift for stories, memory tables and cost events', diff.status === 0 && ours.length === 0, { status: diff.status, ours, stderr: diff.stderr?.slice(0, 400) });
  console.log(`Schema diff outside this task: ${statements.length ? statements.join(' | ').slice(0, 400) : 'none'}`);

  // Last-resort schema rollback for a code rollback: pair uniqueness returns, messages stay.
  const messagesBeforeRollback = (await rows('SELECT COUNT(*)::int AS count FROM "Message"'))[0].count;
  await ddl.query(readFileSync(join(root, 'prisma/sql/chat-threads-rollback.sql'), 'utf8'));
  const rolledIndexes = (await rows("SELECT indexname FROM pg_indexes WHERE tablename IN ('Memory', 'CoreMemory')")).map((row) => row.indexname);
  const perPair = await rows('SELECT "userId", "characterId", COUNT(*)::int AS count FROM "Memory" GROUP BY 1, 2 HAVING COUNT(*) > 1');
  check('rollback SQL restores pair uniqueness, keeps every message and the latest story memory',
    rolledIndexes.includes('Memory_userId_characterId_key') && rolledIndexes.includes('CoreMemory_userId_characterId_key') && perPair.length === 0
    && (await rows('SELECT COUNT(*)::int AS count FROM "Message"'))[0].count === messagesBeforeRollback
    && (await rows(`SELECT "summary" FROM "Memory" WHERE "userId" = 'u1' AND "characterId" = 'c1'`))[0]?.summary === 'Сводка u1:c1'
    && (await rows(`SELECT 1 FROM "ChatPromptState" WHERE "scopeKey" = 'user:u1' AND "characterId" = 'c1'`)).length === 1, { rolledIndexes, perPair });
  await ddl.end();
}

// ---------------------------------------------------------------------------------------------
// Part A2. The production order via an SQL console: migration without the uniqueness swap, the
// SQL backfill, rows written by the previous code meanwhile, a second backfill, then the full file.
// ---------------------------------------------------------------------------------------------
const UNIQUENESS_MARKER = '-- Uniqueness moves only now';
async function phasedDeployPart() {
  const url = h.databaseUrl.replace(/\/nv_memory_test$/, '/nv_threads_phased');
  const admin = new pg.Client({ connectionString: h.databaseUrl.replace(/\/nv_memory_test$/, '/postgres') });
  await admin.connect();
  await admin.query('CREATE DATABASE nv_threads_phased');
  await admin.end();
  const sql = new pg.Client({ connectionString: url });
  await sql.connect();
  const q2 = async (text, params = []) => (await sql.query(text, params)).rows;
  try {
    const names = readdirSync(join(root, 'prisma/migrations')).filter((name) => /^\d+_/.test(name)).sort();
    for (const name of names.filter((name) => name < MIGRATION)) await sql.query(migrationSql(name));
    await sql.query(`INSERT INTO "User" ("id", "email") VALUES ('pu1', 'pu1@example.test'), ('pu2', 'pu2@example.test')`);
    await sql.query(`INSERT INTO "Character" ("id", "name", "userId", "updatedAt", "isPublic") VALUES ('pc1', 'Лео', 'pu1', NOW(), true)`);
    for (let i = 0; i < 6; i += 1) {
      await sql.query('INSERT INTO "Message" ("id", "characterId", "chatId", "userId", "role", "content", "createdAt") VALUES ($1, \'pc1\', \'pc1\', $2, \'user\', $3, NOW() - ($4 || \' minutes\')::interval)',
        [`pm${i}`, i < 4 ? 'pu1' : 'pu2', `реплика ${i}`, String(60 - i)]);
    }
    await sql.query(`INSERT INTO "Memory" ("id", "characterId", "userId", "summary") VALUES ('pmem1', 'pc1', 'pu1', 'Сводка')`);
    const full = migrationSql(MIGRATION);
    const cut = full.indexOf(UNIQUENESS_MARKER);
    check('the migration has the uniqueness block at its end', cut > 0 && !full.slice(cut).includes('INSERT INTO'));
    // Like the Adminer SQL console: split on semicolons, run one statement at a time on one session.
    const adminer = async (text) => {
      const statements = text.split(';').map((part) => part.trim()).filter((part) => part && !/^(--[^\n]*\n?\s*)+$/.test(part + '\n'));
      let last = null;
      for (const statement of statements) last = await sql.query(statement);
      return last;
    };
    await adminer(`BEGIN;\n${full.slice(0, cut)}\nCOMMIT;`);
    const indexes = async () => (await q2("SELECT indexname FROM pg_indexes WHERE tablename = 'Memory'")).map((row) => row.indexname);
    check('step 1 keeps the old pair uniqueness the previous code relies on', (await indexes()).includes('Memory_userId_characterId_key') && (await indexes()).includes('Memory_threadId_key'));
    const backfillSql = readFileSync(join(root, 'prisma/sql/chat-threads-backfill.sql'), 'utf8');
    const runBackfill = async () => {
      const statements = `BEGIN;\n${backfillSql}`.split(';').map((part) => part.trim()).filter(Boolean);
      let counts = null;
      for (const statement of statements) {
        const result = await sql.query(statement);
        if (result.command === 'SELECT') counts = result.rows[0];
      }
      await sql.query('COMMIT');
      return counts;
    };
    const first = await runBackfill();
    check('SQL backfill leaves nothing without a story', Object.values(first).every((count) => Number(count) === 0), first);
    // Previous code still running: a message for an existing pair and a new pair, plus a memory row.
    await sql.query(`INSERT INTO "Message" ("id", "characterId", "chatId", "userId", "role", "content") VALUES ('late-a', 'pc1', 'pc1', 'pu1', 'user', 'поздняя'), ('late-b', 'pc1', 'pc1', 'pu2', 'user', 'поздняя 2')`);
    await sql.query(`INSERT INTO "User" ("id", "email") VALUES ('pu3', 'pu3@example.test')`);
    await sql.query(`INSERT INTO "Message" ("id", "characterId", "chatId", "userId", "role", "content") VALUES ('late-c', 'pc1', 'pc1', 'pu3', 'user', 'новая пара')`);
    const second = await runBackfill();
    const stories = await q2('SELECT "userId", COUNT(*)::int AS count FROM "ChatThread" GROUP BY 1 ORDER BY 1');
    check('second SQL backfill adopts the deployment window and creates a story for a new pair',
      Object.values(second).every((count) => Number(count) === 0) && JSON.stringify(stories) === JSON.stringify([{ userId: 'pu1', count: 1 }, { userId: 'pu2', count: 1 }, { userId: 'pu3', count: 1 }]), { second, stories });
    const touched = await q2(`SELECT t."lastMessageAt" >= m."createdAt" AS fresh FROM "ChatThread" t JOIN "Message" m ON m."threadId" = t."id" WHERE m."id" = 'late-a'`);
    check('adopted rows move the story activity forward', touched[0]?.fresh === true);
    await adminer(`BEGIN;\n${full}\nCOMMIT;`);
    check('the full file afterwards completes the uniqueness swap', !(await indexes()).includes('Memory_userId_characterId_key') && (await indexes()).includes('Memory_userId_characterId_idx'));
    const third = await runBackfill();
    check('a backfill after everything is a no-op', Object.values(third).every((count) => Number(count) === 0)
      && (await q2('SELECT COUNT(*)::int AS count FROM "ChatThread"'))[0].count === 3);
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------------------------
// Part B. Application paths with stories enabled (and the flag-off fallback at the end).
// ---------------------------------------------------------------------------------------------
const routeFile = {
  chat: 'src/app/api/chat/[id]/route.ts',
  regenerate: 'src/app/api/chat/[id]/regenerate/route.ts',
  clear: 'src/app/api/chat/[id]/messages/route.ts',
  memory: 'src/app/api/chat/[id]/memory/route.ts',
  summary: 'src/app/api/chat/[id]/memory/summary/route.ts',
  core: 'src/app/api/chat/[id]/memory/core/route.ts',
  episodic: 'src/app/api/chat/[id]/memory/episodic/route.ts',
  episodicItem: 'src/app/api/chat/[id]/memory/episodic/[episodicId]/route.ts',
  refresh: 'src/app/api/chat/[id]/memory/refresh-summary/route.ts',
  persona: 'src/app/api/chat/[id]/persona/route.ts',
  prompt: 'src/app/api/chat/[id]/story-settings/route.ts',
  threads: 'src/app/api/chat/[id]/threads/route.ts',
  thread: 'src/app/api/chat/[id]/threads/[threadId]/route.ts',
  message: 'src/app/api/messages/[id]/route.ts',
  chats: 'src/app/api/chats/route.ts',
  personas: 'src/app/api/personas/route.ts',
};

async function call(userId, name, method, path, { body, params = {} } = {}) {
  session.userId = userId;
  const route = load(join(root, routeFile[name]));
  const request = new NextRequest(`http://localhost${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-locale': 'ru' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = name === 'chats' ? await route.GET() : await route[method](request, { params: Promise.resolve(params) });
  const text = await response.text();
  const lines = text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } });
  await h.settle();
  return { status: response.status, json: lines.length === 1 ? lines[0] : null, events: lines.filter(Boolean) };
}

const q = (threadId) => (threadId ? `?thread=${threadId}` : '');
const threadHash = (threadId) => createHmac('sha256', 'synthetic_memory_actor').update(`thread:${threadId}`).digest('hex');
const promptText = (turn) => turn.messages.map((message) => String(message.content)).join('\n');

async function appPart() {
  process.env.CHAT_THREADS_ENABLED = '1';
  await helpers.model(16_000);
  const owner = await helpers.user('story');
  const character = await helpers.character(owner.id, 'Вампир Лео');
  const other = await helpers.character(owner.id, 'Капитан');
  const a = await helpers.user('story');
  const id = character.id;

  // --- Old dialog: migrated story with legacy rows still opens and continues. ---
  const legacy = await helpers.messages(a.id, id, [
    { role: 'assistant', content: 'Добро пожаловать в Москву, путник.' },
    { role: 'user', content: 'Где мы? Мы в Москве, у Кремля.' },
    { role: 'assistant', content: 'Да, мы в Москве у Кремля, война кланов в разгаре.' },
  ], { threadId: null });
  await db.memory.create({ data: { userId: a.id, characterId: id, summary: '## Недавние события\n1. Герои гуляют по Москве.', lastSummarizedAt: legacy[0].createdAt } });
  await db.coreMemory.create({ data: { userId: a.id, characterId: id, content: '## Пользователь\n- Живёт в Москве.' } });
  await db.episodicMemory.create({ data: { userId: a.id, characterId: id, event: 'Прибыли в Москву на совет кланов', importance: 3 } });
  const personaMoscow = await db.persona.create({ data: { userId: a.id, name: 'Агент Москвы', description: 'Служит клану.' } });
  await db.personaSelection.create({ data: { userId: a.id, characterId: id, personaId: personaMoscow.id } });
  const client = new pg.Client({ connectionString: h.databaseUrl });
  await client.connect();
  const backfill = await backfillChatThreads(client, { batchSize: 2 });
  await client.end();
  check('legacy rows of the app database are assigned by the same backfill', Object.values(backfill.remaining).every((count) => count === 0) && backfill.storiesCreated >= 1, backfill);
  const story1 = await db.chatThread.findFirstOrThrow({ where: { userId: a.id, characterId: id } });
  await h.mirrorMessages(await db.message.findMany({ where: { threadId: story1.id } }));
  const opened = await call(a.id, 'chat', 'GET', `/api/chat/${id}`, { params: { id } });
  check('old dialog opens with all messages and its story', opened.status === 200 && opened.json.messages.length === 3
    && opened.json.thread?.id === story1.id && opened.json.thread.number === 1 && opened.json.threadsEnabled === true, opened.json?.thread);
  const memory1 = await call(a.id, 'memory', 'GET', `/api/chat/${id}/memory`, { params: { id } });
  check('old memory is shown for the old dialog', JSON.stringify(memory1.json).includes('Москв') && memory1.json.core?.content?.includes('Москве'));
  provider.reply = 'Мы всё ещё в Москве.';
  const continued = await h.chat(a.id, id, { message: 'Продолжим совет.' });
  check('old dialog continues in the same story', (await db.message.count({ where: { threadId: story1.id } })) === 5
    && continued.events.some((event) => event.type === 'meta' && event.thread?.id === story1.id));
  check('cost events carry the story hash, never the raw id',
    (await db.aiCostEvent.findMany({ where: { threadHash: threadHash(story1.id) } })).length > 0
    && (await db.aiCostEvent.count({ where: { threadHash: story1.id } })) === 0);

  // --- Two stories (memory-model-v2, 9.2): story 2 knows Mars, never Moscow. ---
  const created = await call(a.id, 'threads', 'POST', `/api/chat/${id}/threads`, { params: { id }, body: { sourceThreadId: story1.id } });
  const story2 = created.json?.thread;
  check('a new story is created with the next number', created.status === 201 && story2?.number === 2 && story2.status === 'active', created.json);
  check('a new story copies the persona of the current story and has empty memory',
    (await db.chatThread.findUnique({ where: { id: story2.id } })).personaId === personaMoscow.id
    && (await db.memory.count({ where: { threadId: story2.id } })) === 0 && (await db.coreMemory.count({ where: { threadId: story2.id } })) === 0);
  const personaMars = await db.persona.create({ data: { userId: a.id, name: 'Космонавт Ари', description: 'Пилот экспедиции.' } });
  const personaSet = await call(a.id, 'persona', 'POST', `/api/chat/${id}/persona${q(story2.id)}`, { params: { id }, body: { personaId: personaMars.id } });
  check('persona is chosen for story 2 only', personaSet.status === 200
    && (await db.chatThread.findUnique({ where: { id: story1.id } })).personaId === personaMoscow.id);
  provider.reply = 'Ветер несёт красную пыль Марса.';
  const greeting = await h.chat(a.id, id, { message: 'Мы приземлились на Марсе у кратера Гейла.' }, 'ru', story2.id);
  check('first turn of a new story starts without the other story', !/Москв|Кремл|Агент Москвы/.test(promptText(greeting)), promptText(greeting).slice(0, 300));
  provider.reply = 'Мы на Марсе, у кратера Гейла.';
  provider.intent = 'question';
  const where2 = await h.chat(a.id, id, { message: 'Где мы?' }, 'ru', story2.id);
  check('two stories: "Где мы?" in story 2 sees Mars', /Марс/.test(promptText(where2)) && /Космонавт Ари/.test(where2.system));
  check('two stories: no Moscow in messages, RAG, core, episodes, summary or persona of story 2', !/Москв|Кремл|Агент Москвы|совет кланов/.test(promptText(where2)), promptText(where2).slice(0, 600));
  const where1 = await h.chat(a.id, id, { message: 'Где мы?' }, 'ru', story1.id);
  check('control: the same question in story 1 still sees Moscow', /Москв/.test(promptText(where1)) && !/Марс|Космонавт/.test(promptText(where1)));
  check('cost events of the two stories are attributed separately',
    (await db.aiCostEvent.count({ where: { threadHash: threadHash(story2.id) } })) > 0
    && (await db.aiCostEvent.count({ where: { threadHash: threadHash(story1.id) } })) > 0);
  const memory2 = await call(a.id, 'memory', 'GET', `/api/chat/${id}/memory${q(story2.id)}`, { params: { id } });
  check('memory editor of story 2 holds nothing from story 1', memory2.status === 200 && !JSON.stringify(memory2.json).includes('Москв'));
  const core1 = await db.coreMemory.findUnique({ where: { threadId: story1.id } });
  check('background memory of story 2 never writes into story 1', core1.content === '## Пользователь\n- Живёт в Москве.'
    && (await db.episodicMemory.count({ where: { threadId: story1.id } })) === 1);
  const editSummary = await call(a.id, 'summary', 'PUT', `/api/chat/${id}/memory/summary${q(story2.id)}`, { params: { id }, body: { summary: 'Экспедиция на Марсе.' } });
  check('memory editor writes into the selected story', editSummary.status === 200
    && (await db.memory.findUnique({ where: { threadId: story2.id } })).summary === 'Экспедиция на Марсе.'
    && (await db.memory.findUnique({ where: { threadId: story1.id } })).summary.includes('Москве'));
  const prompt2 = await call(a.id, 'prompt', 'GET', `/api/chat/${id}/story-settings${q(story2.id)}`, { params: { id } });
  check('a new story pins its own prompt state', prompt2.status === 200
    && !!(await db.chatPromptState.findUnique({ where: { scopeKey_characterId: { scopeKey: `thread:${story2.id}`, characterId: id } } })));

  // --- Owner isolation: a foreign story is 404 everywhere, with no side effects. ---
  const b = await helpers.user('story');
  const bRows = await helpers.messages(b.id, id, [{ role: 'user', content: 'Привет' }, { role: 'assistant', content: 'Здравствуй' }]);
  const snapshotAll = async () => JSON.stringify(await Promise.all([
    db.message.count(), db.chatThread.findMany({ orderBy: { id: 'asc' } }), db.memory.findMany({ orderBy: { id: 'asc' } }),
    db.coreMemory.count(), db.episodicMemory.count(), db.memoryEntry.count(), db.aiCostEvent.count(), db.transaction.count(),
    db.chatPromptState.count(), db.personaSelection.findMany({ orderBy: { id: 'asc' } }), db.user.findUnique({ where: { id: b.id }, select: { verseCoins: true } }),
  ]));
  const beforeForeign = await snapshotAll();
  const foreign = story1.id;
  const otherCharacterStory = (await call(a.id, 'threads', 'POST', `/api/chat/${other.id}/threads`, { params: { id: other.id }, body: {} })).json.thread.id;
  const afterSetup = await snapshotAll();
  const attempts = [
    ['chat GET', 'chat', 'GET', `/api/chat/${id}${q(foreign)}`],
    ['chat POST', 'chat', 'POST', `/api/chat/${id}${q(foreign)}`, { message: 'Взлом' }],
    ['continue', 'chat', 'POST', `/api/chat/${id}${q(foreign)}`, { continue: true }],
    ['regenerate', 'regenerate', 'POST', `/api/chat/${id}/regenerate${q(foreign)}`, { messageId: bRows[1].id }],
    ['clear', 'clear', 'DELETE', `/api/chat/${id}/messages${q(foreign)}`],
    ['memory GET', 'memory', 'GET', `/api/chat/${id}/memory${q(foreign)}`],
    ['summary PUT', 'summary', 'PUT', `/api/chat/${id}/memory/summary${q(foreign)}`, { summary: 'x' }],
    ['core PUT', 'core', 'PUT', `/api/chat/${id}/memory/core${q(foreign)}`, { content: 'x' }],
    ['episodic POST', 'episodic', 'POST', `/api/chat/${id}/memory/episodic${q(foreign)}`, { event: 'x', importance: 3 }],
    ['episodic DELETE', 'episodicItem', 'DELETE', `/api/chat/${id}/memory/episodic/x${q(foreign)}`, undefined, { episodicId: 'x' }],
    ['refresh', 'refresh', 'POST', `/api/chat/${id}/memory/refresh-summary${q(foreign)}`, { mode: 'refresh' }],
    ['persona GET', 'persona', 'GET', `/api/chat/${id}/persona${q(foreign)}`],
    ['persona POST', 'persona', 'POST', `/api/chat/${id}/persona${q(foreign)}`, { personaId: personaMars.id }],
    ['persona DELETE', 'persona', 'DELETE', `/api/chat/${id}/persona${q(foreign)}`],
    ['prompt GET', 'prompt', 'GET', `/api/chat/${id}/story-settings${q(foreign)}`],
    ['prompt POST', 'prompt', 'POST', `/api/chat/${id}/story-settings${q(foreign)}`, { mode: 'character' }],
    ['rename', 'thread', 'PATCH', `/api/chat/${id}/threads/${foreign}`, { title: 'Чужое' }, { threadId: foreign }],
    ['archive', 'thread', 'PATCH', `/api/chat/${id}/threads/${foreign}`, { status: 'archived' }, { threadId: foreign }],
    ['delete', 'thread', 'DELETE', `/api/chat/${id}/threads/${foreign}`, { confirmed: true }, { threadId: foreign }],
    ['new with foreign source', 'threads', 'POST', `/api/chat/${id}/threads`, { sourceThreadId: foreign }],
    ['malformed id', 'chat', 'GET', `/api/chat/${id}?thread=..%2Fx`],
    ['own story of another character', 'chat', 'GET', `/api/chat/${id}${q(otherCharacterStory)}`],
  ];
  const statuses = [];
  for (const [label, name, method, path, body, extra] of attempts) {
    const user = label === 'own story of another character' ? a.id : b.id;
    const result = await call(user, name, method, path, { params: { id, ...(extra ?? {}) }, body });
    statuses.push(`${label}:${result.status}`);
    check(`foreign story → 404 (${label})`, result.status === 404 && !JSON.stringify(result.json ?? {}).includes(story1.id), result);
  }
  check('foreign story attempts change nothing (messages, stories, memory, costs, VC, prompt state, persona)', afterSetup === await snapshotAll(), statuses);
  check('setup of the isolation check only added the other-character story', beforeForeign !== afterSetup);

  // --- Regenerate, continue, edit, delete and clear stay inside the selected story. ---
  const story1Rows = async () => JSON.stringify(await db.message.findMany({ where: { threadId: story1.id }, orderBy: { id: 'asc' }, select: { id: true, content: true, createdAt: true, finishReason: true } }));
  const story1Before = await story1Rows();
  const lastIn2 = await db.message.findFirst({ where: { threadId: story2.id, role: 'assistant' }, orderBy: { createdAt: 'desc' } });
  provider.reply = 'Переписанный ответ про Марс.';
  const regenerated = await call(a.id, 'regenerate', 'POST', `/api/chat/${id}/regenerate${q(story2.id)}`, { params: { id }, body: { messageId: lastIn2.id } });
  const regenRequest = provider.chatRequests.at(-1).body.messages.map((m) => String(m.content)).join('\n');
  check('regenerate replaces only the answer of story 2', regenerated.status === 200
    && (await db.message.findUnique({ where: { id: lastIn2.id } })).content === 'Переписанный ответ про Марс.' && story1Before === await story1Rows());
  check('regenerate context comes from story 2 only', !/Москв|Кремл/.test(regenRequest));
  const crossRegen = await call(a.id, 'regenerate', 'POST', `/api/chat/${id}/regenerate${q(story1.id)}`, { params: { id }, body: { messageId: lastIn2.id } });
  check('regenerate refuses a message of another story than the one in the request', crossRegen.status === 404);
  provider.reply = 'Продолжение марсианской сцены.';
  const cont = await call(a.id, 'chat', 'POST', `/api/chat/${id}${q(story2.id)}`, { params: { id }, body: { continue: true } });
  const contEnd = cont.events.find((event) => event.type === 'end');
  check('continue writes into story 2', cont.status === 200 && (await db.message.findUnique({ where: { id: contEnd.assistantMessage.id } })).threadId === story2.id && story1Before === await story1Rows());
  const userIn2 = await db.message.findFirst({ where: { threadId: story2.id, role: 'user' } });
  const edited = await call(a.id, 'message', 'PUT', `/api/messages/${userIn2.id}`, { params: { id: userIn2.id }, body: { content: 'Исправленная реплика на Марсе.' } });
  const removedId = contEnd.assistantMessage.id;
  const removed = await call(a.id, 'message', 'DELETE', `/api/messages/${removedId}`, { params: { id: removedId } });
  check('edit and delete touch only the chosen message of story 2', edited.status === 200 && removed.status === 200
    && !(await db.message.findUnique({ where: { id: removedId } })) && story1Before === await story1Rows());

  // --- Deleting a story removes its messages, embeddings and memory; others stay. ---
  const story3 = (await call(a.id, 'threads', 'POST', `/api/chat/${id}/threads`, { params: { id }, body: { title: 'Сосед' } })).json.thread;
  const rows3 = await helpers.messages(a.id, id, [{ role: 'user', content: 'Привет, сосед.' }, { role: 'assistant', content: 'Привет!' }], { threadId: story3.id });
  for (const row of [...rows3, ...JSON.parse(story1Before).slice(0, 1)]) {
    await db.$executeRawUnsafe('INSERT INTO "MessageEmbedding" ("id", "messageId", "embedding") VALUES ($1, $2, $3)', `emb3_${row.id}`, row.id, Buffer.from([1]));
    await db.$executeRawUnsafe('INSERT INTO "MessageEmbeddingDeepinfra" ("id", "messageId", "embedding") VALUES ($1, $2, $3)', `di3_${row.id}`, row.id, Buffer.from([1]));
  }
  await db.memory.create({ data: { userId: a.id, characterId: id, threadId: story3.id, summary: 'Соседская сводка' } });
  await db.coreMemory.create({ data: { userId: a.id, characterId: id, threadId: story3.id, content: 'Соседское ядро' } });
  await db.episodicMemory.create({ data: { userId: a.id, characterId: id, threadId: story3.id, event: 'Соседи познакомились', importance: 3 } });
  await db.memoryEntry.create({ data: { userId: a.id, characterId: id, threadId: story3.id, type: 'summary', content: 'Соседская сводка' } });
  await call(a.id, 'prompt', 'GET', `/api/chat/${id}/story-settings${q(story3.id)}`, { params: { id } });
  const totalBefore = (await db.character.findUnique({ where: { id } })).totalMessages;
  const unconfirmed = await call(a.id, 'thread', 'DELETE', `/api/chat/${id}/threads/${story3.id}`, { params: { id, threadId: story3.id }, body: {} });
  check('deleting a story requires explicit confirmation', unconfirmed.status === 400 && !!(await db.chatThread.findUnique({ where: { id: story3.id } })));
  const otherCounts = async () => JSON.stringify(await Promise.all([story1.id, story2.id].map(async (threadId) => [
    await db.message.count({ where: { threadId } }), await db.memory.count({ where: { threadId } }), await db.coreMemory.count({ where: { threadId } }),
    await db.episodicMemory.count({ where: { threadId } }), await db.memoryEntry.count({ where: { threadId } }),
  ])));
  const othersBefore = await otherCounts();
  const deleted = await call(a.id, 'thread', 'DELETE', `/api/chat/${id}/threads/${story3.id}`, { params: { id, threadId: story3.id }, body: { confirmed: true } });
  const embeddingsLeft = await db.$queryRawUnsafe('SELECT (SELECT COUNT(*)::int FROM "MessageEmbedding" WHERE "id" LIKE \'emb3_%\') AS a, (SELECT COUNT(*)::int FROM "MessageEmbeddingDeepinfra" WHERE "id" LIKE \'di3_%\') AS b');
  check('deleting story 3 removes its messages, both embedding stores, memory and prompt state', deleted.status === 200 && deleted.json.deletedMessages === 2
    && !(await db.chatThread.findUnique({ where: { id: story3.id } })) && (await db.message.count({ where: { id: { in: rows3.map((row) => row.id) } } })) === 0
    && embeddingsLeft[0].a === 1 && embeddingsLeft[0].b === 1
    && (await db.memory.count({ where: { userId: a.id, characterId: id, summary: 'Соседская сводка' } })) === 0
    && (await db.episodicMemory.count({ where: { event: 'Соседи познакомились' } })) === 0
    && !(await db.chatPromptState.findUnique({ where: { scopeKey_characterId: { scopeKey: `thread:${story3.id}`, characterId: id } } })), { deleted: deleted.json, embeddingsLeft });
  check('deleting a story leaves the other stories and the cumulative counter intact', othersBefore === await otherCounts()
    && (await db.character.findUnique({ where: { id } })).totalMessages === totalBefore);
  const clear2 = await call(a.id, 'clear', 'DELETE', `/api/chat/${id}/messages${q(story2.id)}`, { params: { id } });
  check('clearing story 2 empties it but keeps the story and story 1', clear2.status === 200 && (await db.message.count({ where: { threadId: story2.id } })) === 0
    && !!(await db.chatThread.findUnique({ where: { id: story2.id } })) && story1Before !== null && (await db.message.count({ where: { threadId: story1.id } })) > 0
    && (await db.memory.count({ where: { threadId: story2.id } })) === 0);

  // --- Rename, archive, restore, list. ---
  const tooLong = await call(a.id, 'thread', 'PATCH', `/api/chat/${id}/threads/${story2.id}`, { params: { id, threadId: story2.id }, body: { title: 'М'.repeat(81) } });
  const renamed = await call(a.id, 'thread', 'PATCH', `/api/chat/${id}/threads/${story2.id}`, { params: { id, threadId: story2.id }, body: { title: '  Марс\u0000 экспедиция  ' } });
  check('rename validates length and normalizes the title', tooLong.status === 400 && renamed.status === 200 && renamed.json.thread.title === 'Марс экспедиция');
  const autoTitle = await call(a.id, 'thread', 'PATCH', `/api/chat/${id}/threads/${story2.id}`, { params: { id, threadId: story2.id }, body: { title: '' } });
  check('an empty title returns to the automatic "Story N"', autoTitle.json.thread.title === null);

  // --- Return after a break opens the chosen (latest active) story. ---
  await db.chatThread.update({ where: { id: story1.id }, data: { lastMessageAt: new Date(Date.now() - 86_400_000) } });
  await db.chatThread.update({ where: { id: story2.id }, data: { lastMessageAt: new Date(Date.now() - 3_600_000) } });
  const back = await call(a.id, 'chat', 'GET', `/api/chat/${id}`, { params: { id } });
  check('returning without a story opens the latest active story', back.json.thread.id === story2.id);
  provider.reply = 'Снова Москва.';
  await h.chat(a.id, id, { message: 'Вернёмся в Москву.' }, 'ru', story1.id);
  const back2 = await call(a.id, 'chat', 'GET', `/api/chat/${id}`, { params: { id } });
  check('writing in an older story makes it the one that opens next time', back2.json.thread.id === story1.id);
  const archived = await call(a.id, 'thread', 'PATCH', `/api/chat/${id}/threads/${story1.id}`, { params: { id, threadId: story1.id }, body: { status: 'archived' } });
  const back3 = await call(a.id, 'chat', 'GET', `/api/chat/${id}`, { params: { id } });
  check('an archived story is skipped by default but still opens explicitly', archived.status === 200 && back3.json.thread.id === story2.id
    && (await call(a.id, 'chat', 'GET', `/api/chat/${id}${q(story1.id)}`, { params: { id } })).json.thread.status === 'archived');
  provider.reply = 'Архив ожил.';
  await h.chat(a.id, id, { message: 'Продолжаем архивную историю.' }, 'ru', story1.id);
  check('a new message restores an archived story', (await db.chatThread.findUnique({ where: { id: story1.id } })).status === 'active');
  const list = await call(a.id, 'threads', 'GET', `/api/chat/${id}/threads`, { params: { id } });
  check('story list shows own stories of this character with counts', list.status === 200 && list.json.threads.length === 2
    && list.json.threads.every((thread) => typeof thread.messageCount === 'number') && list.json.threads[0].id === story1.id);
  const chats = await call(a.id, 'chats', 'GET', '/api/chats');
  check('/api/chats lists one row per story with its title data', chats.status === 200 && chats.json.threadsEnabled === true
    && chats.json.data.filter((row) => row.character.id === id).length === 2 && chats.json.data.some((row) => row.thread?.id === otherCharacterStory && row.lastMessage === null));

  // --- Guest claim never mixes into an existing story. ---
  const transfer = load(join(root, 'src/lib/anonymousTransfer.ts'));
  const seedGuest = async (sessionId, mode = 'character') => {
    await db.anonymousSession.create({ data: { sessionId, expiresAt: new Date(Date.now() + 86_400_000), messagesCount: 1 } });
    await db.anonymousChatRequest.create({ data: { requestId: `${sessionId}-r1`, sessionId, characterId: id, status: 'completed', userContent: 'Гостевой привет' } });
    await db.anonymousMessage.createMany({ data: [
      { sessionId, characterId: id, role: 'user', content: 'Гостевой привет', requestId: `${sessionId}-r1`, createdAt: new Date(Date.now() - 60_000) },
      { sessionId, characterId: id, role: 'assistant', content: 'Гостевой ответ', requestId: `${sessionId}-r1`, createdAt: new Date(Date.now() - 50_000) },
    ] });
    await db.chatPromptState.create({ data: { scopeKey: `guest:${sessionId}`, characterId: id, builderVersion: 1, mode } });
  };
  const aCounts = await otherCounts();
  await seedGuest('guest-a');
  const claimA = await transfer.transferAnonymousChatToUser({ sessionId: 'guest-a', userId: a.id });
  const claimedThread = claimA.threads?.[0]?.threadId;
  const claimedStory = claimedThread ? await db.chatThread.findUnique({ where: { id: claimedThread } }) : null;
  // Numbers follow the highest existing story (story 3 was deleted above).
  check('guest claim with existing stories becomes a new separate story', claimA.ok && claimA.copied === 2 && claimedStory?.number === 3
    && ![story1.id, story2.id].includes(claimedThread) && (await db.message.count({ where: { threadId: claimedThread } })) === 2 && aCounts === await otherCounts(), claimA);
  const reclaim = await transfer.transferAnonymousChatToUser({ sessionId: 'guest-a', userId: a.id });
  check('a repeated claim creates nothing', reclaim.ok && reclaim.alreadyTransferred && (await db.chatThread.count({ where: { userId: a.id, characterId: id } })) === 3);
  check('a claimed story opens next (latest activity)', (await call(a.id, 'chat', 'GET', `/api/chat/${id}`, { params: { id } })).json.thread.id === claimedThread);
  const d = await helpers.user('start');
  await seedGuest('guest-d');
  const claimD = await transfer.transferAnonymousChatToUser({ sessionId: 'guest-d', userId: d.id });
  const storyD = await db.chatThread.findMany({ where: { userId: d.id, characterId: id } });
  check('guest claim without stories becomes the default story', claimD.ok && storyD.length === 1 && storyD[0].number === 1
    && (await db.message.count({ where: { threadId: storyD[0].id } })) === 2
    && !!(await db.chatPromptState.findUnique({ where: { scopeKey_characterId: { scopeKey: `thread:${storyD[0].id}`, characterId: id } } })));

  // --- Validation and URL privacy. ---
  const threads = load(join(root, 'src/lib/chatThreads.ts'));
  check('story ids are validated before any query', !threads.isValidThreadId('../x') && !threads.isValidThreadId('a'.repeat(65)) && threads.isValidThreadId(story1.id));
  const privacy = load(join(root, 'src/lib/urlPrivacy.ts'));
  const page = `https://newverse.test/ru/chat/${id}?thread=${story1.id}&utm_source=x`;
  check('story id never reaches analytics and the page is private (no-referrer)', !privacy.analyticsUrl(page, 'https://newverse.test').includes(story1.id)
    && privacy.analyticsUrl(page, 'https://newverse.test').includes('utm_source=x') && privacy.isPrivatePageUrl(new URL(page)));

  // --- Flag off: previous behaviour without rolling the schema back. ---
  process.env.CHAT_THREADS_ENABLED = '0';
  const e = await helpers.user('start');
  const offList = await call(a.id, 'threads', 'GET', `/api/chat/${id}/threads`, { params: { id } });
  const offCreate = await call(a.id, 'threads', 'POST', `/api/chat/${id}/threads`, { params: { id }, body: {} });
  check('flag off: the story API does not exist', offList.status === 404 && offCreate.status === 404);
  const latest = await db.chatThread.findFirst({ where: { userId: a.id, characterId: id }, orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }] });
  const offGet = await call(a.id, 'chat', 'GET', `/api/chat/${id}${q(story2.id)}`, { params: { id } });
  check('flag off: the story parameter is ignored and the single (latest) story opens', offGet.status === 200 && offGet.json.thread === null
    && offGet.json.threadsEnabled === false && offGet.json.messages.length === await db.message.count({ where: { threadId: latest.id } }));
  const straggler = await db.message.create({ data: { userId: a.id, characterId: id, chatId: id, role: 'user', content: 'Строка без истории от старого кода' } });
  const offGet2 = await call(a.id, 'chat', 'GET', `/api/chat/${id}`, { params: { id } });
  check('flag off: unassigned legacy rows stay visible like before', offGet2.json.messages.some((message) => message.id === straggler.id));
  process.env.CHAT_THREADS_ENABLED = '1';
  const onGet = await call(a.id, 'chat', 'GET', `/api/chat/${id}${q(latest.id)}`, { params: { id } });
  check('flag on: an unassigned row is not shown in any story', !onGet.json.messages.some((message) => message.id === straggler.id));
  process.env.CHAT_THREADS_ENABLED = '0';
  const offChats = await call(a.id, 'chats', 'GET', '/api/chats');
  check('flag off: /api/chats has the previous per-character shape', offChats.json.threadsEnabled === undefined && offChats.json.data.every((row) => !row.thread));
  provider.reply = 'Ответ без историй.';
  const offTurn = await h.chat(a.id, id, { message: 'Сообщение при выключенном флаге.' }, 'ru', story2.id);
  check('flag off: a message goes into the single story and the stream has no story fields', (await db.message.count({ where: { threadId: latest.id, content: 'Сообщение при выключенном флаге.' } })) === 1
    && offTurn.events.every((event) => event.threadId === undefined && event.thread === undefined));
  const eStory = await helpers.thread(e.id, id);
  await helpers.messages(e.id, id, [{ role: 'user', content: 'Старое' }, { role: 'assistant', content: 'Старый ответ' }], { threadId: eStory.id });
  await seedGuest('guest-e');
  const claimE = await transfer.transferAnonymousChatToUser({ sessionId: 'guest-e', userId: e.id });
  check('flag off: guest claim merges into the single story like before', claimE.ok && (await db.chatThread.count({ where: { userId: e.id, characterId: id } })) === 1
    && (await db.message.count({ where: { threadId: eStory.id } })) === 4);
  process.env.CHAT_THREADS_ENABLED = '1';
}

try {
  if (!mutation) {
    await migrationPart();
    await phasedDeployPart();
  }
  await appPart();
  console.log(`Chat threads verification: ${passed} passed`);
} finally {
  await ddl.end().catch(() => {});
  await h.stop();
}
