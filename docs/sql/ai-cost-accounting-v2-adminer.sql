-- Target: verified NewVerse production database default_db, schema public.
-- Run only after a fresh completed backup and explicit approval.
-- Execute this entire block together. Do not run individual statements.
-- The migration is atomic; an error must be followed by ROLLBACK before retry.
-- This does not create or mark any Prisma migration history.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
  IF current_database() <> 'default_db' THEN
    RAISE EXCEPTION 'Wrong target database; expected default_db';
  END IF;
  IF to_regclass('public."AiCostEvent"') IS NULL THEN
    RAISE EXCEPTION 'Expected public.AiCostEvent is missing';
  END IF;
END
$guard$;

ALTER TABLE public."AiCostEvent"
  ADD COLUMN "providerResponseId" TEXT,
  ADD COLUMN "apiSurface" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "accountingVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "providerCostSemantics" TEXT NOT NULL DEFAULT 'unverified',
  ADD COLUMN "cacheWriteInputTokens" INTEGER;

CREATE INDEX "AiCostEvent_provider_providerRequestId_idx"
  ON public."AiCostEvent" ("provider", "providerRequestId");
CREATE INDEX "AiCostEvent_provider_providerResponseId_idx"
  ON public."AiCostEvent" ("provider", "providerResponseId");
COMMIT;
