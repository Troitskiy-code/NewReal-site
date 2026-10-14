// Apply only this feature's additive migration, without unrelated pending changes.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';

const migration = '20261014110000_character_generation_batches';
const sql = readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8');
const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('Configure MIGRATION_DATABASE_URL, DIRECT_URL or DATABASE_URL');
const client = new Client({ connectionString, connectionTimeoutMillis: 15_000 });
try {
  await client.connect(); await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [migration]);
  const table = await client.query(`SELECT to_regclass('public."CharacterGenerationBatch"') IS NOT NULL AS present`);
  const ledger = await client.query(`SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS present`);
  if (!ledger.rows[0].present) throw new Error('Prisma migration history is missing; inspect the database before applying');
  const recorded = await client.query('SELECT checksum, finished_at FROM "_prisma_migrations" WHERE migration_name=$1 AND rolled_back_at IS NULL', [migration]);
  const checksum = createHash('sha256').update(sql).digest('hex');
  if (recorded.rows.length) {
    if (recorded.rows[0].checksum !== checksum || !recorded.rows[0].finished_at || !table.rows[0].present)
      throw new Error('Migration history and schema do not agree');
    await client.query('COMMIT'); console.log('Character generation migration already applied.');
  } else {
    if (table.rows[0].present) throw new Error('Generation tables already exist without migration history; inspect before applying');
    await client.query(sql);
    await client.query(`INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,started_at,applied_steps_count)
      VALUES ($1,$2,NOW(),$3,NOW(),1)`, [randomUUID(), checksum, migration]);
    await client.query('COMMIT'); console.log('Character generation tables added; existing characters unchanged.');
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.log('Migration not applied: ' + (error?.code || error?.name || 'Error'));
  process.exitCode = 1;
} finally { await client.end(); }
