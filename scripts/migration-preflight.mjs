// Read-only. Does not load .env and never runs a migration/resolve automatically.
import { Client } from 'pg';
import { Prisma } from '@prisma/client';
import { readdirSync, readFileSync } from 'node:fs';
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('Set MIGRATION_DATABASE_URL explicitly for the intended database');
const mode = process.argv.includes('--ready') ? 'ready' : 'baseline';
const historical = readdirSync('prisma/migrations').filter(n => /^\d+_/.test(n) && n !== '20260801000000_baseline')
  .map(n => readFileSync(`prisma/migrations/${n}/migration.sql`, 'utf8')).join('\n');
const addedTables = new Set([...historical.matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)"/g)].map(m => m[1]));
const addedColumns = new Set([...historical.matchAll(/ALTER TABLE\s+"([^"]+)"\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"([^"]+)"/g)].map(m => `${m[1]}.${m[2]}`));
const client = new Client({ connectionString: url });
try {
  await client.connect();
  const columns = await client.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'");
  const present = new Set(columns.rows.map(r => `${r.table_name}.${r.column_name}`));
  const orphans = {};
  for (const [table, parent, field, parentField] of [
    ['AnonymousMessage', 'AnonymousSession', 'sessionId', 'sessionId'],
    ['AnonymousChatRequest', 'AnonymousSession', 'sessionId', 'sessionId'],
    ['SupportTicket', 'User', 'userId', 'id'],
  ]) {
    if (present.has(`${table}.${field}`) && present.has(`${parent}.${parentField}`)) {
      const result = await client.query(`SELECT COUNT(*)::int AS count FROM "${table}" child
        LEFT JOIN "${parent}" parent ON parent."${parentField}" = child."${field}"
        WHERE child."${field}" IS NOT NULL AND parent."${parentField}" IS NULL`);
      if (result.rows[0].count) orphans[table] = result.rows[0].count;
    }
  }
  const missing = [];
  for (const model of Prisma.dmmf.datamodel.models) {
    if (mode === 'baseline' && addedTables.has(model.name)) continue;
    for (const field of model.fields.filter(f => f.kind !== 'object')) {
      const key = `${model.dbName ?? model.name}.${field.dbName ?? field.name}`;
      if (mode === 'baseline' && addedColumns.has(key)) continue;
      if (!present.has(key)) missing.push(key);
    }
  }
  // Unsupported vector fields are not exposed in the Prisma DMMF.
  if (!present.has('MessageEmbedding.embedding')) missing.push('MessageEmbedding.embedding');
  if (missing.length || Object.keys(orphans).length) {
    console.error(JSON.stringify({ ok: false, mode, missingColumns: missing, orphanCounts: orphans })); process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, mode, action: 'read_only',
      next: mode === 'baseline' ? 'Review types, constraints and migration history on a restored copy before marking this baseline applied.' : 'Schema columns are ready; confirm migration status separately.' }));
  }
  const relation = await client.query("SELECT to_regclass('public._prisma_migrations') AS relation");
  if (relation.rows[0].relation) {
    const history = await client.query('SELECT migration_name, finished_at IS NOT NULL AS applied, rolled_back_at IS NOT NULL AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name');
    console.log(JSON.stringify({ migrationHistory: history.rows }));
    if (history.rows.some(r => !r.applied && !r.rolled_back)) process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, category: 'database_preflight', code: /^[A-Z0-9]{3,10}$/.test(error.code ?? '') ? error.code : undefined }));
  process.exitCode = 1;
} finally { await client.end(); }
