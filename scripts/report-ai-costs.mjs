// Explicit read-only connection. Does not load .env, mutate DB or call providers.
import { Client } from 'pg';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAiCostReport } from './lib/ai-cost-report.mjs';
import { loadKodikCostExport } from './lib/kodik-cost-export.mjs';

const url = process.env['COST_REPORT_DATABASE_URL'];
if (!url) throw new Error('Set COST_REPORT_DATABASE_URL explicitly for the intended database');
const days = Number(process.env['COST_REPORT_DAYS'] ?? 14);
if (!Number.isSafeInteger(days) || days < 1 || days > 366) throw new Error('COST_REPORT_DAYS must be 1..366');
const parseDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('Report dates require an explicit timezone');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid report date');
  return date;
};
const to = process.env['COST_REPORT_TO'] ? parseDate(process.env['COST_REPORT_TO']) : new Date();
const from = process.env['COST_REPORT_FROM'] ? parseDate(process.env['COST_REPORT_FROM']) : new Date(to.getTime() - days * 86400000);
if (from >= to || to.getTime() - from.getTime() > 366 * 86400000) throw new Error('Invalid report interval');
const client = new Client({ connectionString: url });
try {
  let ledgerRows;
  if (process.env['KODIK_COST_EXPORT']) {
    const path = resolve(process.env['KODIK_COST_EXPORT']);
    ledgerRows = loadKodikCostExport(path, { naiveTimezone: process.env['KODIK_COST_EXPORT_TIMEZONE'] });
  }
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  // No actors, prompts, emails, secrets or response bodies are selected.
  const { rows } = await client.query(`
    SELECT "id", "provider", "providerRequestId", "providerResponseId", "apiSurface", "accountingVersion",
      "model", "actualModel", "purpose", "audience", "outcome", "usageSource", "costSource",
      "inputTokens", "outputTokens", "inputCharacters", "chargedVC", "quotedVC",
      "inputRubPerMillion", "outputRubPerMillion", "reportedCostRub", "estimatedCostRub"
    FROM "AiCostEvent" WHERE "createdAt" >= $1 AND "createdAt" < $2
    ORDER BY "createdAt", "id" LIMIT 200001
  `, [from.toISOString(), to.toISOString()]);
  if (rows.length > 200000) throw new Error('Choose a shorter report interval');
  await client.query('COMMIT');
  const result = buildAiCostReport(rows, { from: from.toISOString(), to: to.toISOString(),
    ledgerRows, apiKeyName: process.env['KODIK_COST_API_KEY_NAME'] });
  if (process.env['COST_REPORT_OUTPUT']) {
    writeFileSync(resolve(process.env['COST_REPORT_OUTPUT']), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ written: true, coverage: result.coverage, reconciliation: result.reconciliation }));
  } else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ category: 'cost_report', code: /^[A-Z0-9]{3,10}$/.test(error.code ?? '') ? error.code : undefined }));
  process.exitCode = 1;
} finally { await client.end(); }
