// Explicit read-only connection; never loads .env, never sends conversions.
import { Client } from 'pg';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPaymentAttributionReport } from './lib/payment-attribution-report.mjs';

const url = process.env['PAYMENT_REPORT_DATABASE_URL'];
if (!url) throw new Error('Set PAYMENT_REPORT_DATABASE_URL explicitly (read-only role recommended)');
const parseUtc = name => {
  const raw = process.env[name];
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new Error(`Set ${name} to an explicit UTC timestamp ending in Z`);
  return new Date(raw);
};
const from = parseUtc('PAYMENT_REPORT_FROM'), to = parseUtc('PAYMENT_REPORT_TO');
if (from >= to || to - from > 366 * 86400000) throw new Error('Invalid reporting interval (maximum 366 days)');
const testUsers = (process.env['PAYMENT_TEST_USER_IDS'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
const db = new Client({ connectionString: url });
let rows;
try {
  await db.connect(); await db.query('BEGIN READ ONLY');
  await db.query("SET LOCAL TIME ZONE 'UTC'");
  await db.query("SET LOCAL statement_timeout = '30s'");
  const { rows: mode } = await db.query('SHOW transaction_read_only');
  if (mode[0]?.transaction_read_only !== 'on') throw new Error('Read-only transaction required');
  ({ rows } = await db.query(`
    SELECT e."id" AS "eventId", e."invoiceId", e."createdAt" AT TIME ZONE 'UTC' AS "createdAt", e."kind", e."amountRub", e."planId",
      o."id" AS "orderId", o."attribution", o."packageId",
      COALESCE(o."isTest", false) OR e."userId" = ANY($3::text[]) AS "isTest",
      CASE WHEN e."kind" = 'subscription_renewal' THEN 'renewal'
        WHEN EXISTS (SELECT 1 FROM "PaymentEvent" earlier WHERE earlier."userId" = e."userId"
          AND earlier."provider" = e."provider" AND earlier."kind" IN ('purchase','subscription','subscription_pending')
          AND (earlier."createdAt", earlier."id") < (e."createdAt", e."id")) THEN 'repeat' ELSE 'first' END AS "cohort",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('goal', r."goal", 'state', r."state", 'attempts', r."attempts"))
        FROM "PaymentGoalReceipt" r WHERE r."eventId" = e."id"), '[]'::jsonb) AS "receipts"
    FROM "PaymentEvent" e LEFT JOIN "PaymentOrder" o ON o."provider" = e."provider" AND o."invoiceId" = e."invoiceId"
      AND o."userId" = e."userId" AND o."amountRub" = e."amountRub"
      AND o."planId" IS NOT DISTINCT FROM e."planId"
      AND o."kind" = CASE WHEN e."kind" = 'purchase' THEN 'purchase' WHEN e."kind" IN ('subscription','subscription_pending') THEN 'subscription' ELSE NULL END
    WHERE e."provider" = 'robokassa' AND e."createdAt" >= ($1::timestamptz AT TIME ZONE 'UTC')
      AND e."createdAt" < ($2::timestamptz AT TIME ZONE 'UTC')
    ORDER BY e."createdAt", e."id" LIMIT 100001`, [from, to, testUsers]));
  if (rows.length > 100000) throw new Error('Report exceeds 100000 payments; use a shorter interval');
  await db.query('ROLLBACK');
} finally { await db.end(); }
const refunds = process.env['PAYMENT_REFUNDS_FILE'] ? JSON.parse(readFileSync(resolve(process.env['PAYMENT_REFUNDS_FILE']), 'utf8')) : null;
const report = buildPaymentAttributionReport(rows, { from: from.toISOString(), to: to.toISOString(), refunds });
// Detailed order identifiers stay in a private temporary directory, outside Git.
const directory = mkdtempSync(join(tmpdir(), 'nv-payment-attribution-'));
const output = join(directory, 'report.json');
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report.summary, output }, null, 2));
