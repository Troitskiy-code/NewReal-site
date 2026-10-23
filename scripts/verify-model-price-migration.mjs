// In-memory PostgreSQL only: never loads .env or connects to the project database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migration = readFileSync('prisma/migrations/20261020120000_deepinfra_vc_prices/migration.sql', 'utf8');
const catalog = JSON.parse(readFileSync('src/lib/data/deepinfra-chat-models-2026-10-11.json', 'utf8'));
try {
  await db.exec('CREATE TABLE "Model" ("id" text PRIMARY KEY, "name" text UNIQUE, "displayName" text, "pricePer1MInput" float, "pricePer1MOutput" float, "priceVC" int, "maxContextTokens" int, "description" text, "isFreeForSubscribers" boolean, "isActive" boolean, "createdAt" timestamp);');
  await db.exec(readFileSync('prisma/migrations/20261011210000_deepinfra_chat_catalog/migration.sql', 'utf8'));
  await db.exec(readFileSync('prisma/migrations/20261016120000_deepinfra_pilot_models/migration.sql', 'utf8'));
  const before = (await db.query('SELECT * FROM "Model" ORDER BY "id"')).rows;
  await db.exec(migration);
  const after = (await db.query('SELECT * FROM "Model" ORDER BY "id"')).rows;
  assert.equal(after.filter((row, i) => row.priceVC !== before[i].priceVC).length, 7);
  for (let i = 0; i < before.length; i++) {
    const { priceVC: oldPrice, ...oldFields } = before[i];
    const { priceVC: newPrice, ...newFields } = after[i];
    assert.deepEqual(newFields, oldFields, 'all non-price fields must remain unchanged');
    assert.equal(newPrice, catalog.find(m => m.name === after[i].name).priceVC);
  }
  await db.exec(migration);
  assert.deepEqual((await db.query('SELECT * FROM "Model" ORDER BY "id"')).rows, after, 'replay is idempotent');
  await db.query('UPDATE "Model" SET "priceVC" = 999 WHERE "name" = $1', ['deepinfra:moonshotai/Kimi-K2.6']);
  await db.query('UPDATE "Model" SET "priceVC" = 6 WHERE "name" = $1', ['deepinfra:Qwen/Qwen3-Next-80B-A3B-Instruct']);
  const invalid = (await db.query('SELECT * FROM "Model" ORDER BY "id"')).rows;
  await assert.rejects(db.exec(migration), /missing model or unexpected price/);
  await db.exec('ROLLBACK');
  assert.deepEqual((await db.query('SELECT * FROM "Model" ORDER BY "id"')).rows, invalid, 'guard failure leaves every row unchanged');
  console.log('PASS: exactly 7 price changes; catalogue agreement; all other fields preserved; idempotent replay; unexpected-price guard; atomic rollback. No external database or AI calls.');
} finally { await db.close(); }
