// Actual SQL, Prisma, handlers and row locks on disposable localhost PostgreSQL.
// Never loads .env values, calls paid AI, or connects to production.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { createModuleLoader } from './lib/memory-test-harness.mjs';

const root = process.cwd(), require = createRequire(import.meta.url);
const runtime = resolve(process.env['GUEST_TEST_RUNTIME'] || join(tmpdir(), 'nv-p1-isolated-runtime'));
const EmbeddedPostgres = require(join(runtime, 'node_modules/embedded-postgres/dist/index.js')).default;
const { Client } = require('pg');
async function freePort() {
  const socket = createServer();
  await new Promise((done, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', done); });
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  return port;
}
const directory = mkdtempSync(join(tmpdir(), 'nv-prompt-rollout-')), port = await freePort();
const databaseUrl = `postgresql://postgres:synthetic_prompt_only@127.0.0.1:${port}/nv_prompt_rollout`;
const pg = new EmbeddedPostgres({ databaseDir: join(directory, 'db'), user: 'postgres', password: 'synthetic_prompt_only',
  port, persistent: true, initdbFlags: ['--encoding=UTF8'], onLog() {} });
const env = { ...process.env };
for (const key of Object.keys(env)) if (/KEY|SECRET|TOKEN|PASSWORD|DATABASE|DIRECT_URL|LOGTAIL/i.test(key)) env[key] = '';
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (existsSync(file)) for (const match of readFileSync(file, 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) env[match[1]] = '';
}
Object.assign(env, { DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl, MIGRATION_DATABASE_URL: databaseUrl,
  NEXTAUTH_SECRET: 'synthetic_prompt_session', ADMIN_SECRET: 'synthetic_prompt_admin', RP_PROMPT_V2_ENABLED: 'true',
  NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' });
Object.assign(process.env, env);
globalThis.fetch = async () => { throw new Error('External requests prohibited in migration verification'); };
// Generate before even constructing PrismaClient: on Windows its engine DLL is
// loaded asynchronously by the constructor and cannot then be replaced.
if (process.argv.includes('--build')) {
  const generated = spawnSync(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'generate', '--schema', join(root, 'prisma/schema.prisma')],
    { cwd: directory, env, encoding: 'utf8', timeout: 90000, windowsHide: true });
  if (generated.status !== 0) throw new Error(`Private Prisma generation failed: ${generated.stderr || generated.stdout}`);
}
const db = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
const sql = new Client({ connectionString: databaseUrl });
const session = { userId: null }, { load } = createModuleLoader({ prismaFor: () => db, session });
const service = load(join(root, 'src/lib/promptMigration.ts'));
const policy = load(join(root, 'src/lib/promptRolloutPolicy.ts'));
const state = load(join(root, 'src/lib/promptState.ts'));
const admin = load(join(root, 'src/app/api/admin/prompt-migration/route.ts'));
const publicRoute = load(join(root, 'src/app/api/prompts/rollout/route.ts'));
const storyRoute = load(join(root, 'src/app/api/chat/[id]/prompt-version/route.ts'));
const cardVersionRoute = load(join(root, 'src/app/api/characters/[id]/prompt-version/route.ts'));
let checks = 0, browser, app, currentPage, started = false;
function equal(a, b, label) { assert.deepEqual(a, b, label); checks++; console.log(`PASS ${label}`); }
function check(value, label) { assert.ok(value, label); checks++; console.log(`PASS ${label}`); }
async function rejected(work, label) { await assert.rejects(work, service.PromptMigrationConflict); checks++; console.log(`PASS ${label}`); }
const adminRequest = (body, authorization = `Bearer ${env.ADMIN_SECRET}`, origin = 'https://newvers.ai') => new Request('https://newvers.ai/api/admin/prompt-migration', {
  method: 'POST', headers: { authorization, origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const fullCard = id => db.character.findUnique({ where: { id }, select: service.promptMigrationSelect });
async function reviewed(id, fields = {}) {
  const card = await fullCard(id);
  return service.reviewPromptMigration(id, service.promptFingerprint(card), fields);
}
try {
  await pg.initialise(); await pg.start(); started = true; await pg.createDatabase('nv_prompt_rollout');
  const schema = join(directory, 'schema.prisma');
  writeFileSync(schema, readFileSync('prisma/schema.prisma', 'utf8').replace(/Unsupported\("vector\(\d+\)"\)/g, 'Bytes'));
  const pushed = spawnSync(process.execPath, [join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate', '--schema', schema],
    { cwd: directory, env, encoding: 'utf8', timeout: 90000, windowsHide: true });
  if (pushed.status !== 0) throw new Error(`Private schema failed: ${pushed.stderr || pushed.stdout}`);
  await sql.connect();
  const owner = await db.user.create({ data: { email: 'prompt-owner@example.test', emailVerified: new Date() } });
  const reader = await db.user.create({ data: { email: 'prompt-reader@example.test' } });
  const staleCard = await db.character.create({ data: { id: 'stale-card', userId: owner.id, name: 'Старая карточка', description: 'Содержимое карточки', systemPrompt: 'LEGACY_SENTINEL  \nточный оригинал' } });
  // Reproduce the deployed pre-upgrade schema; execute the exact committed SQL twice.
  await sql.query('DROP TABLE "PromptMigrationStory"; DROP TABLE "PromptMigrationEntry"; DROP TABLE "PromptRollout"; DROP INDEX IF EXISTS "ChatPromptState_characterId_builderVersion_idx"; ALTER TABLE "ChatPromptState" DROP COLUMN "promptMigrationId"');
  const migration = readFileSync('prisma/migrations/20261012193000_prompt_bulk_rollout/migration.sql', 'utf8');
  await sql.query(`BEGIN; ${migration} COMMIT;`);
  await sql.query(`BEGIN; ${migration} COMMIT;`);
  equal((await fullCard(staleCard.id)).systemPrompt, staleCard.systemPrompt, 'SQL preserves original card text byte for byte');
  equal(await db.promptRollout.findUnique({ where: { id: 'rp-v2' } }).then(row => row.finalized), false, 'SQL initializes unfinished rollout');
  check((await sql.query("SELECT indexdef FROM pg_indexes WHERE indexname='PromptMigrationEntry_active_card_idx'")).rows[0].indexdef.includes("'applied'"), 'actual PostgreSQL enforces one applied entry per card');
  equal((await sql.query("SELECT indexname FROM pg_indexes WHERE indexname='ChatPromptState_characterId_builderVersion_idx'")).rows.length, 1, 'SQL creates the per-card story index');
  equal((await admin.GET(new Request('https://newvers.ai/api/admin/prompt-migration?action=detail&characterId=stale-card'))).status, 401, 'anonymous admin request cannot expose original prompts');
  equal((await admin.POST(adminRequest({ action: 'finalize', confirmed: true }, 'Bearer wrong'))).status, 401, 'invalid admin credential cannot mutate');
  equal((await admin.POST(adminRequest({ action: 'finalize', confirmed: true }, undefined, 'https://foreign.test'))).status, 403, 'foreign browser origin rejected');
  equal((await admin.POST(adminRequest({ action: 'apply', confirmed: true, entryIds: ['missing'] }))).status, 400, 'apply requires explicit backup confirmation');
  equal((await admin.POST(adminRequest({ action: 'finalize', confirmed: true }))).status, 400, 'finalization requires quality acceptance');
  equal((await admin.POST(adminRequest({ action: 'review', confirmed: true, fingerprint: 'x', characterId: 'stale-card', fields: {} }))).status, 400, 'malformed fingerprint rejected');
  equal((await admin.POST(adminRequest({ action: 'apply', confirmed: true, backupConfirmed: true, entryIds: Array(6).fill('missing') }))).status, 400, 'oversized batch rejected');
  equal((await admin.POST(adminRequest({ action: 'review', confirmed: true, padding: 'x'.repeat(66000) }))).status, 413, 'oversized body rejected');
  const beforeReview = await fullCard(staleCard.id);
  const staleEntry = await reviewed(staleCard.id);
  equal(await fullCard(staleCard.id), beforeReview, 'review leaves card version and original prompt intact');
  await db.character.update({ where: { id: staleCard.id }, data: { description: 'Правки владельца' } });
  await rejected(() => service.applyPromptMigration(staleEntry.entryId), 'changed card blocks stale conversion');
  equal((await fullCard(staleCard.id)).legacyPromptArchive, null, 'failed conversion has no archive/version side effects');
  const newer = await reviewed(staleCard.id);
  equal((await db.promptMigrationEntry.findUnique({ where: { id: staleEntry.entryId } })).status, 'superseded', 're-review supersedes obsolete proposal');
  process.env.RP_PROMPT_V2_ENABLED = 'false';
  await rejected(() => service.applyPromptMigration(newer.entryId), 'global disabled flag blocks conversion');
  process.env.RP_PROMPT_V2_ENABLED = 'true';
  await rejected(() => service.finalizePromptRollout(), 'legacy cards block premature finalization');
  const card = await db.character.create({ data: { id: 'world-card', userId: owner.id, isPublic: true, name: 'Хранитель острова', description: 'Только описание героя',
    systemPrompt: 'LEGACY_PRIVATE_SENTINEL: ведущий острова.  \nСохрани точные пробелы.', description_en: 'Old translation', scenario: 'Начало', roleplayMode: 'character', privateMemory: 'PERSONAL_MEMORY_SENTINEL' } });
  const before = await fullCard(card.id);
  await db.message.createMany({ data: [owner, reader].map(user => ({ userId: user.id, characterId: card.id, role: 'assistant', content: 'HISTORY_SENTINEL' })) });
  await db.coreMemory.create({ data: { userId: owner.id, characterId: card.id, content: 'CORE_MEMORY_SENTINEL' } });
  const immutable = async () => ({ messages: await db.message.findMany({ orderBy: { id: 'asc' } }), memory: await db.coreMemory.findMany({ orderBy: { id: 'asc' } }), vc: (await db.user.findUnique({ where: { id: owner.id } })).verseCoins });
  const untouched = await immutable();
  await db.chatPromptState.createMany({ data: [
    { scopeKey: `user:${owner.id}`, characterId: card.id, builderVersion: 1, mode: 'character' },
    { scopeKey: 'user:pinned-v2', characterId: card.id, builderVersion: 2, mode: 'character' },
  ] });
  const entry = await reviewed(card.id, { roleplayMode: 'world', description: 'Ведущий острова', rpConfig: { world: 'Остров над облаками', canonicalNotes: 'Никто не управляет действиями игрока' } });
  equal(await fullCard(card.id), before, 'saving approved proposal does not alter any card fields');
  await sql.query(`CREATE FUNCTION nv_fail_prompt_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW."characterId" = 'world-card' AND NEW."builderVersion" = 2 THEN RAISE EXCEPTION 'SYNTHETIC_PRIVATE_FAILURE_LINE'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER nv_fail_prompt_update BEFORE UPDATE ON "ChatPromptState" FOR EACH ROW EXECUTE FUNCTION nv_fail_prompt_update();`);
  const logger = load(join(root, 'src/lib/logger.ts')), consoleLines = [], sinkLines = [];
  const oldError = console.error;
  logger.setDiagnosticSink({ error: line => sinkLines.push(line), info() {}, debug() {} });
  console.error = (...args) => consoleLines.push(args.join(' '));
  let failedBody;
  try { failedBody = await admin.POST(adminRequest({ action: 'apply', entryIds: [entry.entryId], confirmed: true, backupConfirmed: true })).then(response => response.json()); }
  finally { console.error = oldError; logger.setDiagnosticSink(null); }
  equal(failedBody.results[0].status, 'failed', 'actual handler reports a mid-transaction database failure safely');
  check(consoleLines.length > 0 && sinkLines.length > 0, 'mid-transaction failure reaches both diagnostic channels');
  check(!JSON.stringify([failedBody, consoleLines, sinkLines]).includes('SYNTHETIC_PRIVATE_FAILURE_LINE'), 'handler and both diagnostic channels omit raw database error text');
  equal(await fullCard(card.id), before, 'failed state update rolls back preceding card/archive changes');
  equal(await db.promptMigrationStory.count({ where: { entryId: entry.entryId } }), 0, 'failed transaction also rolls back created history backups');
  equal((await db.promptMigrationEntry.findUnique({ where: { id: entry.entryId } })).status, 'reviewed', 'failed transaction remains retryable');
  await sql.query('DROP TRIGGER nv_fail_prompt_update ON "ChatPromptState"; DROP FUNCTION nv_fail_prompt_update()');
  const concurrent = await Promise.all([service.applyPromptMigration(entry.entryId), service.applyPromptMigration(entry.entryId)]);
  equal(concurrent.map(row => row.status).sort(), ['already_applied', 'applied'], 'simultaneous replay converts exactly once under row lock');
  equal(await db.promptMigrationStory.count({ where: { entryId: entry.entryId } }), 1, 'only v1 story receives original-state backup');
  equal((await fullCard(card.id)).legacyPromptArchive, before.systemPrompt, 'conversion archives exact legacy text');
  equal((await fullCard(card.id)).description_en, null, 'changed source description invalidates old translation');
  equal(await state.getOrCreatePromptState(`user:${owner.id}`, card.id, card), { builderVersion: 2, mode: 'world' }, 'existing v1 story receives approved world mode');
  equal(await state.getOrCreatePromptState('user:pinned-v2', card.id, card), { builderVersion: 2, mode: 'character' }, 'pre-existing v2 mode remains pinned');
  equal(await state.getOrCreatePromptState(`user:${reader.id}`, card.id, card), { builderVersion: 2, mode: 'world' }, 'untracked historical dialogue receives approved migration on first open');
  equal(await state.getOrCreatePromptState('user:fresh', card.id, card), { builderVersion: 2, mode: 'world' }, 'new story created after apply follows v2');
  equal((await db.promptMigrationStory.findUnique({ where: { entryId_scopeKey: { entryId: entry.entryId, scopeKey: 'user:fresh' } } })).builderVersion, 1, 'fresh migrated story has rollback baseline');
  session.userId = owner.id;
  equal((await cardVersionRoute.POST(new Request('https://newvers.ai/api/characters/world-card/prompt-version', { method: 'POST', body: JSON.stringify({ version: 1, confirmed: true }) }), { params: Promise.resolve({ id: card.id }) })).status, 409, 'managed card cannot bypass its migration snapshot by manual downgrade');
  const manual = await storyRoute.POST(new Request('https://newvers.ai/api/chat/world-card/prompt-version', { method: 'POST', body: JSON.stringify({ version: 2, mode: 'character', confirmed: true }) }), { params: Promise.resolve({ id: card.id }) });
  equal(manual.status, 200, 'user can explicitly preserve another story mode before finalization');
  equal((await db.chatPromptState.findUnique({ where: { scopeKey_characterId: { scopeKey: `user:${owner.id}`, characterId: card.id } } })).promptMigrationId, null, 'explicit user switch removes rollback ownership');
  await db.chatPromptState.create({ data: { scopeKey: 'user:manual-v1', characterId: card.id, builderVersion: 1, mode: 'world' } });
  check((await service.promptMigrationQueue(true)).entryIds.includes(entry.entryId), 'catch-up queue finds v1 states on an already applied card');
  equal((await service.applyPromptMigration(entry.entryId)).status, 'already_applied', 'ordinary replay never overrides a subsequent user downgrade');
  equal((await service.alignPromptMigrationStories(entry.entryId)).stories, 1, 'separate approved catch-up converts leftover v1 story');
  equal((await service.alignPromptMigrationStories(entry.entryId)).stories, 0, 'catch-up replay performs no repeated conversions');
  await db.character.update({ where: { id: card.id }, data: { scenario: 'Новая сцена владельца' } });
  await rejected(() => service.rollbackPromptMigration(entry.entryId), 'owner edits block destructive automatic rollback');
  await rejected(() => service.alignPromptMigrationStories(entry.entryId), 'mass catch-up stops on edited card');
  await service.alignPromptMigrationStories(entry.entryId, service.promptFingerprint(await fullCard(card.id)));
  equal((await fullCard(card.id)).scenario, 'Новая сцена владельца', 'explicit current-card catch-up preserves owner edits');
  await db.character.update({ where: { id: card.id }, data: { scenario: before.scenario } });
  const guestId = 'synthetic-transfer-guest';
  await db.anonymousSession.create({ data: { sessionId: guestId, expiresAt: new Date(Date.now() + 86400000) } });
  await db.anonymousChatRequest.create({ data: { sessionId: guestId, requestId: 'guest-done', characterId: card.id, status: 'completed', userContent: 'GUEST_USER', assistantContent: 'GUEST_ASSISTANT' } });
  await db.anonymousMessage.createMany({ data: ['user', 'assistant'].map(role => ({ sessionId: guestId, requestId: 'guest-done', characterId: card.id, role, content: `GUEST_${role}` })) });
  await state.getOrCreatePromptState(`guest:${guestId}`, card.id, card);
  const loggedIn = await db.user.create({ data: { email: 'prompt-transfer@example.test' } });
  const transfer = load(join(root, 'src/lib/anonymousTransfer.ts'));
  equal((await transfer.transferAnonymousChatToUser({ sessionId: guestId, userId: loggedIn.id })).copied, 2, 'actual guest transfer copies messages');
  equal((await db.chatPromptState.findUnique({ where: { scopeKey_characterId: { scopeKey: `user:${loggedIn.id}`, characterId: card.id } } })).promptMigrationId, entry.entryId, 'guest transfer carries rollback provenance into new user story');
  equal((await transfer.transferAnonymousChatToUser({ sessionId: guestId, userId: loggedIn.id })).alreadyTransferred, true, 'guest transfer replay remains idempotent');
  const rollback = await service.rollbackPromptMigration(entry.entryId);
  check(rollback.stories >= 4, 'rollback restores registered, lazy-created and transferred stories');
  equal(await fullCard(card.id), before, 'rollback restores exact original prompt fields and translations');
  equal(await state.getOrCreatePromptState(`user:${reader.id}`, card.id, card), { builderVersion: 1, mode: 'character' }, 'historical story restored to v1');
  equal(await state.getOrCreatePromptState(`user:${loggedIn.id}`, card.id, card), { builderVersion: 1, mode: 'character' }, 'transferred story restored with guest baseline');
  equal(await state.getOrCreatePromptState(`user:${owner.id}`, card.id, card), { builderVersion: 2, mode: 'character' }, 'rollback preserves explicit user choice');
  equal(await state.getOrCreatePromptState('user:manual-v1', card.id, card), { builderVersion: 1, mode: 'world' }, 'rollback of catch-up restores the actual pre-catch-up user choice');
  equal((await service.rollbackPromptMigration(entry.entryId)).status, 'already_rolled_back', 'rollback replay is harmless');
  const after = await immutable();
  equal(after.memory, untouched.memory, 'conversion and rollback never modify long-term memories');
  equal((await db.character.findUnique({ where: { id: card.id } })).privateMemory, 'PERSONAL_MEMORY_SENTINEL', 'card private memory is preserved');
  equal(after.vc, untouched.vc, 'conversion never charges VC');
  equal(after.messages.filter(row => row.userId !== loggedIn.id), untouched.messages, 'conversion and rollback preserve original messages');

  // Coordinate a real first-state creation against a conversion waiting on the same card.
  const race = await db.character.create({ data: { id: 'race-card', userId: owner.id, name: 'Гонка', description: 'История', systemPrompt: 'RACE_ORIGINAL' } });
  const raceEntry = await reviewed(race.id, { roleplayMode: 'world' });
  let unlock, locked;
  const held = new Promise(done => { locked = done; }), released = new Promise(done => { unlock = done; });
  const holding = db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Character" WHERE "id" = ${race.id} FOR UPDATE`; locked(); await released; }, { timeout: 15000 });
  await held;
  const applyRace = service.applyPromptMigration(raceEntry.entryId);
  const openRace = state.getOrCreatePromptState('user:racing-reader', race.id, race);
  unlock(); await holding; await Promise.all([applyRace, openRace]);
  equal(await state.getOrCreatePromptState('user:racing-reader', race.id, race), { builderVersion: 2, mode: 'world' }, 'concurrent first-state creation cannot leave a v1 story behind');
  equal(await db.promptMigrationStory.count({ where: { entryId: raceEntry.entryId, scopeKey: 'user:racing-reader' } }), 1, 'racing first-state gets exactly one rollback snapshot');

  const second = await reviewed(card.id, { roleplayMode: 'world' });
  await service.applyPromptMigration(second.entryId); await service.applyPromptMigration(newer.entryId);
  // Group conversion is explicit; a malformed roster never reaches any card update.
  assert.throws(() => service.preparePromptMigration(before, { roleplayMode: 'group', rpConfig: {} })); checks++;
  const group = await db.character.create({ data: { id: 'group-card', userId: owner.id, name: 'Команда', description: 'Старая команда', systemPrompt: 'GROUP_ORIGINAL' } });
  const groupEntry = await reviewed(group.id, { roleplayMode: 'group', rpConfig: { participants: [
    { id: 'one', name: 'Алиса', description: 'Смелая', appearance: '', speechStyle: '' },
    { id: 'two', name: 'Борис', description: 'Осторожный', appearance: '', speechStyle: '' },
  ] } });
  await service.applyPromptMigration(groupEntry.entryId);
  equal(await state.getOrCreatePromptState('user:group-new', group.id, group), { builderVersion: 2, mode: 'group' }, 'approved group conversion pins a valid group story');
  await db.chatPromptState.create({ data: { scopeKey: 'user:manual-group', characterId: group.id, builderVersion: 2, mode: 'group' } });
  await rejected(() => service.rollbackPromptMigration(groupEntry.entryId), 'rollback cannot remove the roster required by a preserved manual group story');
  await db.chatPromptState.update({ where: { scopeKey_characterId: { scopeKey: 'user:manual-group', characterId: group.id } }, data: { mode: 'character' } });
  await state.getOrCreatePromptState(`user:${owner.id}`, group.id, group);
  let releaseGroup, acquiredGroup;
  const groupHeld = new Promise(done => { acquiredGroup = done; }), groupRelease = new Promise(done => { releaseGroup = done; });
  const groupHolding = db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Character" WHERE "id" = ${group.id} FOR UPDATE`; acquiredGroup(); await groupRelease; }, { timeout: 15000 });
  await groupHeld;
  const rollbackRace = service.rollbackPromptMigration(groupEntry.entryId);
  let rollbackWaiting = 0;
  for (let i = 0; i < 100 && rollbackWaiting < 1; i++) {
    rollbackWaiting = Number((await sql.query("SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%Character%' AND query LIKE '%FOR UPDATE%'")).rows[0].count);
    if (rollbackWaiting < 1) await new Promise(done => setTimeout(done, 10));
  }
  const groupSwitch = storyRoute.POST(new Request(`https://newvers.ai/api/chat/${group.id}/prompt-version`, { method: 'POST', body: JSON.stringify({ version: 2, mode: 'group', confirmed: true }) }), { params: Promise.resolve({ id: group.id }) });
  let waiting = 0;
  for (let i = 0; i < 100 && waiting < 2; i++) {
    waiting = Number((await sql.query("SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%Character%'")).rows[0].count);
    if (waiting < 2) await new Promise(done => setTimeout(done, 10));
  }
  releaseGroup(); await groupHolding;
  const [rolledGroup, switchedGroup] = await Promise.all([rollbackRace, groupSwitch]);
  check(rollbackWaiting >= 1 && waiting >= 2, 'rollback and explicit switch really waited in order on the same PostgreSQL card lock');
  equal(rolledGroup.status, 'rolled_back', 'concurrent group rollback completes atomically');
  check(switchedGroup.status !== 200, 'stale manual group switch revalidates the restored card and is rejected');
  equal(await state.getOrCreatePromptState(`user:${owner.id}`, group.id, group), { builderVersion: 1, mode: 'character' }, 'concurrent manual switch cannot resurrect an unsupported group after rollback');
  const roster = [ { id: 'a', name: 'Алиса', description: 'Смелая', appearance: '', speechStyle: '' },
    { id: 'b', name: 'Борис', description: 'Осторожный', appearance: '', speechStyle: '' } ];
  const restoredGroup = await reviewed(group.id, { roleplayMode: 'group', rpConfig: { participants: roster } });
  await service.applyPromptMigration(restoredGroup.entryId);
  const protectedCard = await db.character.create({ data: { id: 'protected-roster', userId: owner.id, name: 'Сохраняемый состав', description: 'История', rpConfig: { participants: roster } } });
  await db.chatPromptState.create({ data: { scopeKey: 'user:pinned-group', characterId: protectedCard.id, builderVersion: 2, mode: 'group' } });
  const missingRoster = await reviewed(protectedCard.id, { roleplayMode: 'world', rpConfig: {} });
  await assert.rejects(() => service.applyPromptMigration(missingRoster.entryId)); checks++;
  equal((await fullCard(protectedCard.id)).promptBuilderVersion, 1, 'conversion cannot drop the roster used by pre-existing group stories');
  const preservedRoster = await reviewed(protectedCard.id, { roleplayMode: 'world' });
  await service.applyPromptMigration(preservedRoster.entryId);
  equal(await state.getOrCreatePromptState('user:pinned-group', protectedCard.id, protectedCard), { builderVersion: 2, mode: 'group' }, 'conversion retains the roster and mode of pre-existing v2 group');
  const batch = await admin.POST(adminRequest({ action: 'apply', entryIds: [newer.entryId, 'missing-entry', second.entryId], confirmed: true, backupConfirmed: true }));
  equal((await batch.json()).results.map(row => row.status), ['already_applied', 'blocked'], 'batch reports completed items and stops at first blocked item');
  await service.finalizePromptRollout();
  equal(await policy.promptRolloutFinalized(), true, 'all cards and persisted stories permit explicit finalization');
  equal(await publicRoute.GET().then(response => response.json()), { rolloutEnabled: true, finalized: true }, 'public rollout response contains no prompts or identifiers');
  equal((await storyRoute.POST(new Request('https://newvers.ai/api/chat/world-card/prompt-version', { method: 'POST', body: JSON.stringify({ version: 1, mode: 'character', confirmed: true }) }), { params: Promise.resolve({ id: card.id }) })).status, 409, 'finalization rejects manual downgrade');
  equal((await cardVersionRoute.POST(new Request('https://newvers.ai/api/characters/world-card/prompt-version', { method: 'POST', body: JSON.stringify({ version: 1, confirmed: true }) }), { params: Promise.resolve({ id: card.id }) })).status, 409, 'finalization rejects card-version downgrade too');
  const createRoute = load(join(root, 'src/app/api/characters/route.ts'));
  const { NextRequest } = require('next/server');
  equal((await createRoute.POST(new NextRequest('https://newvers.ai/api/characters', { method: 'POST', body: JSON.stringify({ name: 'Legacy import', systemPrompt: 'IMPORTED_LEGACY_SENTINEL' }) }))).status, 409, 'finalization rejects new legacy imports before any AI work');
  const native = await db.character.create({ data: { id: 'native-v2', userId: owner.id, name: 'Новая вселенная', description: 'Сюжет', promptBuilderVersion: 2, roleplayMode: 'world' } });
  await db.message.create({ data: { userId: reader.id, characterId: native.id, role: 'user', content: 'OLD_UNTRACKED' } });
  equal(await state.getOrCreatePromptState(`user:${reader.id}`, native.id, native), { builderVersion: 2, mode: 'world' }, 'finalized rollout does not resurrect untracked v1 histories');
  await db.chatPromptState.create({ data: { scopeKey: 'user:unexpected-v1', characterId: card.id, builderVersion: 1 } });
  equal(await policy.promptRolloutFinalized(), false, 'unexpected legacy state reopens controls consistently');
  await db.chatPromptState.deleteMany({ where: { scopeKey: 'user:unexpected-v1' } });
  await service.rollbackPromptMigration(second.entryId);
  equal((await db.promptRollout.findUnique({ where: { id: 'rp-v2' } })).finalized, false, 'rollback automatically reopens migration controls');
  process.env.RP_PROMPT_V2_ENABLED = 'false';
  equal(await policy.promptRolloutFinalized(), false, 'operator kill switch remains authoritative');
  process.env.RP_PROMPT_V2_ENABLED = 'true';

  if (process.argv.includes('--browser')) {
    const appPort = await freePort(), base = `http://127.0.0.1:${appPort}`;
    Object.assign(env, { NEXTAUTH_URL: base, NEXT_PUBLIC_APP_URL: base, RP_PROMPT_V2_ENABLED: 'true' });
    if (process.argv.includes('--build')) {
      const built = spawnSync(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'build'],
        { cwd: root, env, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      if (built.status !== 0) throw new Error(`Synthetic production build failed: ${built.stderr || built.stdout}`);
      check(true, 'production build passes with isolated database and synthetic credentials');
    }
    app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(appPort)], { env, windowsHide: true, stdio: 'ignore' });
    const nativeFetch = (await import('node:http')).get;
    for (let i = 0; i < 60; i++) {
      const ready = await new Promise(done => { const request = nativeFetch(`${base}/robots.txt`, response => { response.resume(); done(response.statusCode === 200); }); request.on('error', () => done(false)); });
      if (ready) break;
      if (i === 59) throw new Error('Private browser server did not start');
      await new Promise(done => setTimeout(done, 500));
    }
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      if (url.pathname.startsWith('/api/admin/prompt-migration') || url.pathname === '/api/prompts/rollout' || !url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/characters/world-card') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(await db.character.findUnique({ where: { id: card.id } })) });
      if (url.pathname === '/api/user/balance') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ verseCoins: 50, canClaimBonus: false, bonusStreak: 0 }) });
      if (url.pathname === '/api/currency/rates') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ USD: 85, EUR: 95 }) });
      if (url.pathname === '/api/avatar-tokens') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ monthlyLimit: 10, monthlyRemaining: 10, tokensUsedThisMonth: 0 }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: url.pathname === '/api/auth/session' ? JSON.stringify({ user: { id: owner.id, name: 'Synthetic Owner', email: owner.email, emailVerified: new Date().toISOString() }, expires: '2030-01-01T00:00:00Z' }) : '[]' });
    });
    const page = await context.newPage(); currentPage = page; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/ru/admin/prompts`);
    await page.waitForFunction(() => document.documentElement.lang === 'ru' && document.documentElement.hasAttribute('data-theme'));
    await page.getByLabel('Ключ администратора').fill(env.ADMIN_SECRET);
    await page.getByLabel('Ключ администратора').press('Enter');
    await page.getByRole('button', { name: 'Обновить', exact: true }).waitFor();
    equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => String(value).includes('synthetic_prompt_admin'))), false, 'browser never persists admin credential');
    await page.getByRole('button', { name: 'Хранитель острова', exact: true }).click();
    await page.getByLabel('Старый промпт (только чтение)').waitFor();
    equal(await page.getByLabel('Старый промпт (только чтение)').inputValue(), before.systemPrompt, 'browser exposes exact archived text only after admin auth');
    check(await page.getByRole('button', { name: 'Сохранить проверку', exact: true }).isDisabled(), 'browser requires manual source comparison');
    await page.getByLabel('Характер персонажа / описание истории').fill('Перенесённый характер');
    await page.getByLabel('Сравнил старый промпт, перенёс необходимые особенности и подтвердил тип истории').check();
    await page.getByRole('button', { name: 'Сохранить проверку', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Проверка сохранена' }).waitFor();
    equal((await fullCard(card.id)).description, before.description, 'browser review saves proposal without converting');
    await page.getByLabel('В пробный пакет').check();
    check(await page.getByRole('button', { name: 'Перевести выбранные (до 5)', exact: true }).isDisabled(), 'browser apply guarded by backup confirmation');
    await page.getByLabel('Свежий бэкап базы создан').check();
    await page.getByRole('button', { name: 'Перевести выбранные (до 5)', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Пакет обработан' }).waitFor();
    equal((await fullCard(card.id)).promptBuilderVersion, 2, 'browser applies reviewed card against real PostgreSQL');
    await db.chatPromptState.create({ data: { scopeKey: 'user:browser-old', characterId: card.id, builderVersion: 1, mode: 'character' } });
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await page.getByRole('button', { name: 'Согласовать оставшиеся истории v1', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor();
    equal((await db.chatPromptState.findUnique({ where: { scopeKey_characterId: { scopeKey: 'user:browser-old', characterId: card.id } } })).builderVersion, 2, 'browser catch-up queue converts newly discovered v1 histories');
    await page.getByRole('button', { name: 'Откатить перевод этой карточки', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Пакет обработан' }).waitFor();
    await page.getByRole('button', { name: 'Сохранить проверку', exact: true }).waitFor();
    equal((await fullCard(card.id)).promptBuilderVersion, 1, 'browser rollback restores card');
    await page.setViewportSize({ width: 390, height: 844 });
    equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile admin has no horizontal overflow');
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await page.getByLabel('Ключ администратора').waitFor();
    equal(await page.getByLabel('Ключ администратора').inputValue(), '', 'logout clears admin credential');
    equal(await page.getByLabel('Старый промпт (только чтение)').count(), 0, 'logout removes private prompt from UI');
    await page.getByLabel('Ключ администратора').fill(env.ADMIN_SECRET);
    await page.getByLabel('Ключ администратора').press('Enter');
    await page.getByRole('button', { name: 'Хранитель острова', exact: true }).click();
    await page.getByLabel('Сравнил старый промпт, перенёс необходимые особенности и подтвердил тип истории').check();
    await page.getByRole('button', { name: 'Сохранить проверку', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Проверка сохранена' }).waitFor();
    await page.getByLabel('Свежий бэкап базы создан').check();
    await page.getByRole('button', { name: 'Перевести все проверенные', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Обработка завершена' }).waitFor();
    check(await page.getByRole('button', { name: 'Завершить переход', exact: true }).isDisabled(), 'browser finalization waits for explicit quality acceptance');
    await page.getByLabel('Пробные ответы новой сборки проверены, качество принято').check();
    await page.getByRole('button', { name: 'Завершить переход', exact: true }).click();
    await page.getByRole('button', { name: 'Переход завершён', exact: true }).waitFor();
    equal(await policy.promptRolloutFinalized(), true, 'browser finalization completes actual rollout');
    await page.goto(`${base}/ru/edit/world-card`);
    await page.getByRole('button', { name: 'Расширенные настройки', exact: true }).click();
    await page.getByRole('button', { name: 'Предпросмотр инструкций', exact: true }).waitFor();
    await page.getByText('Переход со старых инструкций и откат', { exact: true }).waitFor({ state: 'hidden' });
    equal(await page.getByText('Переход со старых инструкций и откат', { exact: true }).count(), 0, 'finalized editor hides per-card migration confirmations');
    equal(errors, [], 'admin browser UI has no runtime errors');
  }
  console.log(`\n${checks} checks passed on disposable PostgreSQL; production and paid AI untouched.`);
} catch (error) {
  if (currentPage) {
    const screenshot = join(directory, 'browser-failure.png');
    await currentPage.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    console.log(`Synthetic browser failure screenshot: ${screenshot}`);
    console.log(`Synthetic browser page: ${currentPage.url()}`);
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (app && app.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else app.kill();
  }
  await db.$disconnect().catch(() => {}); await sql.end().catch(() => {});
  if (started && process.platform === 'win32' && pg.process) {
    const child = pg.process, dataArg = child.spawnargs.indexOf('-D');
    if (dataArg < 0 || resolve(child.spawnargs[dataArg + 1]) !== resolve(join(directory, 'db'))) throw new Error('Refusing to stop unrelated PostgreSQL');
    const closed = new Promise(done => child.once('close', done));
    const stopped = spawnSync(join(dirname(child.spawnfile), 'pg_ctl.exe'), ['stop', '-D', join(directory, 'db'), '-m', 'fast', '-w', '-t', '15'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (stopped.status !== 0) throw new Error('Private PostgreSQL did not stop');
    await closed; pg.process = undefined;
  } else if (started) await pg.stop();
}
