// Completes the ChatThread migration: assigns every legacy row to its story in short batches.
// Idempotent; run after `prisma migrate deploy`, again after the new code is live, and with
// --check before CHAT_THREADS_ENABLED=1 (exit code 1 while any row has no story).
// Does not load .env: the target database must be named explicitly.
import { Client } from 'pg';
import { backfillChatThreads, countUnassigned } from './lib/chat-thread-backfill.mjs';

const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) throw new Error('Set MIGRATION_DATABASE_URL explicitly for the intended database');
const check = process.argv.includes('--check');
const sizeArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
const batchSize = sizeArg ? Number(sizeArg.split('=')[1]) : 5000;
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50000) throw new Error('--batch-size must be 1..50000');

const client = new Client({ connectionString: url });
try {
  await client.connect();
  await client.query("SET lock_timeout = '5s'");
  if (check) {
    const remaining = await countUnassigned(client);
    const ok = Object.values(remaining).every((count) => count === 0);
    console.log(JSON.stringify({ ok, mode: 'check', remaining }));
    if (!ok) process.exitCode = 1;
  } else {
    const result = await backfillChatThreads(client, { batchSize, log: (line) => console.error(line) });
    const ok = Object.values(result.remaining).every((count) => count === 0);
    console.log(JSON.stringify({ ok, mode: 'backfill', ...result }));
    if (!ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, category: 'chat_thread_backfill', code: /^[A-Z0-9]{3,10}$/.test(error.code ?? '') ? error.code : undefined, message: error.message?.slice(0, 200) }));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
