-- Read-only verification. Run before applying and again after successful COMMIT.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
-- Prisma stores createdAt as UTC in timestamp without time zone.
SET LOCAL TIME ZONE 'UTC';

SELECT current_database() AS database_name,
       current_setting('transaction_read_only') AS read_only,
       to_regclass('public."AiCostEvent"') IS NOT NULL AS cost_table_exists,
       to_regclass('public."_prisma_migrations"') IS NOT NULL AS prisma_history_exists;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'AiCostEvent'
  AND column_name IN ('providerResponseId', 'apiSurface', 'accountingVersion',
                      'providerCostSemantics', 'cacheWriteInputTokens')
ORDER BY column_name;

SELECT i.relname AS index_name, ix.indisvalid AS valid,
       ix.indisready AS ready, pg_get_indexdef(ix.indexrelid) AS definition
FROM pg_index AS ix
JOIN pg_class AS t ON t.oid = ix.indrelid
JOIN pg_namespace AS ns ON ns.oid = t.relnamespace
JOIN pg_class AS i ON i.oid = ix.indexrelid
WHERE ns.nspname = 'public' AND t.relname = 'AiCostEvent'
  AND i.relname IN ('AiCostEvent_provider_providerRequestId_idx',
                    'AiCostEvent_provider_providerResponseId_idx')
ORDER BY i.relname;
ROLLBACK;

-- After verifying all five columns, run the following separately:
-- BEGIN TRANSACTION READ ONLY;
-- SET LOCAL statement_timeout = '15s';
-- SET LOCAL TIME ZONE 'UTC';
-- SELECT "accountingVersion", "apiSurface", "outcome", COUNT(*) AS events,
--        MAX("createdAt") AS latest_event
-- FROM public."AiCostEvent"
-- WHERE "createdAt" >= now() - interval '15 minutes'
-- GROUP BY "accountingVersion", "apiSurface", "outcome";
-- ROLLBACK;
-- A new event with accountingVersion=2 after a real AI request is required.
