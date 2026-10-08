-- Apply before deploying accounting v2. Existing amounts are not reclassified
-- as verified RUB debits and existing rows keep accountingVersion=1.
ALTER TABLE "AiCostEvent"
  ADD COLUMN "providerResponseId" TEXT,
  ADD COLUMN "apiSurface" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "accountingVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "providerCostSemantics" TEXT NOT NULL DEFAULT 'unverified',
  ADD COLUMN "cacheWriteInputTokens" INTEGER;
CREATE INDEX "AiCostEvent_provider_providerRequestId_idx" ON "AiCostEvent"("provider", "providerRequestId");
CREATE INDEX "AiCostEvent_provider_providerResponseId_idx" ON "AiCostEvent"("provider", "providerResponseId");
