// Read-only, explicit connection. Does not read .env or print individual actors/prompts.
import { Client } from 'pg';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.env['COST_REPORT_DATABASE_URL'];
if (!url) throw new Error('Set COST_REPORT_DATABASE_URL explicitly for the intended database');
const days = Number(process.env['COST_REPORT_DAYS'] ?? 14);
if (!Number.isSafeInteger(days) || days < 1 || days > 366) throw new Error('COST_REPORT_DAYS must be 1..366');
const to = new Date(), from = new Date(to.getTime() - days * 86400000);
const client = new Client({ connectionString: url });
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const { rows: models } = await client.query(`
    SELECT e."provider", COALESCE(e."actualModel", e."model") AS "model", e."purpose",
      COUNT(*)::int AS attempts,
      COUNT(*) FILTER (WHERE e."audience" = 'guest')::int AS "guestAttempts",
      COUNT(*) FILTER (WHERE e."outcome" = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE e."outcome" IN ('failed', 'cancelled'))::int AS failed,
      COUNT(*) FILTER (WHERE e."outcome" = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE e."outcome" = 'submitted')::int AS "asyncSubmitted",
      COALESCE(SUM(e."inputCharacters"), 0)::float8 AS "translationCharacters",
      COUNT(*) FILTER (WHERE e."usageSource" = 'provider')::int AS "providerUsageCount",
      COUNT(*) FILTER (WHERE e."usageSource" = 'provider' AND e."outcome" = 'completed')::int AS "providerCompletedUsageCount",
      COUNT(*) FILTER (WHERE e."reportedCostRub" IS NOT NULL)::int AS "reportedCostCount",
      COUNT(*) FILTER (WHERE e."reportedCostRub" IS NULL AND e."estimatedCostRub" IS NOT NULL AND e."outcome" = 'completed')::int AS "estimatedCostCount",
      COUNT(*) FILTER (WHERE e."reportedCostRub" IS NULL AND (e."estimatedCostRub" IS NULL OR e."outcome" <> 'completed'))::int AS "unknownCostCount",
      COALESCE(SUM(e."reportedCostRub"), 0)::float8 AS "reportedCostRub",
      COALESCE(SUM(e."estimatedCostRub") FILTER (WHERE e."reportedCostRub" IS NULL AND e."outcome" = 'completed'), 0)::float8 AS "estimatedCostRub",
      COALESCE(SUM(e."chargedVC"), 0)::float8 AS "chargedVC",
      AVG(e."inputTokens") FILTER (WHERE e."usageSource" = 'provider' AND e."outcome" = 'completed')::float8 AS "averageInputTokens",
      AVG(e."outputTokens") FILTER (WHERE e."usageSource" = 'provider' AND e."outcome" = 'completed')::float8 AS "averageOutputTokens",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY e."inputTokens") FILTER (WHERE e."usageSource" = 'provider' AND e."outcome" = 'completed') AS "p50InputTokens",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY e."outputTokens") FILTER (WHERE e."usageSource" = 'provider' AND e."outcome" = 'completed') AS "p50OutputTokens",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY e."inputTokens") FILTER (WHERE e."usageSource" = 'provider' AND e."outcome" = 'completed') AS "p95InputTokens",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY e."outputTokens") FILTER (WHERE e."usageSource" = 'provider' AND e."outcome" = 'completed') AS "p95OutputTokens",
      AVG(e."inputRubPerMillion") FILTER (WHERE e."outcome" = 'completed')::float8 AS "inputRubPerMillion",
      AVG(e."outputRubPerMillion") FILTER (WHERE e."outcome" = 'completed')::float8 AS "outputRubPerMillion",
      AVG(e."quotedVC") FILTER (WHERE e."outcome" = 'completed')::float8 AS "priceVC"
    FROM "AiCostEvent" e
    WHERE e."createdAt" >= $1 AND e."createdAt" < $2
    GROUP BY e."provider", COALESCE(e."actualModel", e."model"), e."purpose" ORDER BY e."purpose", "model"
  `, [from, to]);
  await client.query('COMMIT');
  const total = key => models.reduce((sum, row) => sum + (row[key] ?? 0), 0);
  const result = {
    generatedAt: new Date().toISOString(), from: from.toISOString(), to: to.toISOString(),
    coverage: { attempts: total('attempts'), providerUsage: total('providerUsageCount'),
      reportedCost: total('reportedCostCount'), estimatedCost: total('estimatedCostCount'),
      unknownCost: total('unknownCostCount'), pending: total('pending') },
    totals: { reportedCostRub: total('reportedCostRub'), estimatedCostRub: total('estimatedCostRub'), chargedVC: total('chargedVC') },
    limitations: [
      'Reported and estimated costs are separate. Unknown costs are not zero; totals are incomplete when unknownCost > 0.',
      'Prices are RUB/1M snapshot estimates unless the provider reports a cost with explicitly configured currency.',
      'Avatar costs are configured estimates; reconcile Createya credits/invoices separately.',
      'VC quote, tokens/rates/costs come from event snapshots. Quoted VC describes the selected model; fallback cost rates describe the actual model.',
      'No historical backfill. Chat, memory, intent, embeddings, character prompts/events and avatars are instrumented. Translation counts code points; billing is still an estimate.',
      'Legacy MuAPI submissions are recorded as unknown cost, not priced from user credits. Async provider invoices/completion require separate reconciliation.',
    ], models,
  };
  if (process.env['COST_REPORT_OUTPUT']) {
    writeFileSync(resolve(process.env['COST_REPORT_OUTPUT']), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ written: true, coverage: result.coverage }));
  } else console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ category: 'cost_report', code: /^[A-Z0-9]{3,10}$/.test(error.code ?? '') ? error.code : undefined }));
  process.exitCode = 1;
} finally { await client.end(); }
