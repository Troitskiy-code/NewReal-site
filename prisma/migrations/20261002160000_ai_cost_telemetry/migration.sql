-- Apply before deploying the cost collector. No historical costs are invented.
CREATE TABLE "AiCostEvent" (
  "id" TEXT PRIMARY KEY,
  "operationId" TEXT NOT NULL,
  "actorHash" TEXT,
  "subscriptionType" TEXT,
  "provider" TEXT NOT NULL,
  "providerRequestId" TEXT,
  "quotaReservationId" TEXT,
  "model" TEXT NOT NULL,
  "actualModel" TEXT,
  "purpose" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "outcome" TEXT NOT NULL,
  "httpStatus" INTEGER,
  "durationMs" INTEGER,
  "inputTokens" INTEGER,
  "inputCharacters" INTEGER,
  "characterRubPerMillion" DOUBLE PRECISION,
  "outputTokens" INTEGER,
  "cachedInputTokens" INTEGER,
  "chargedVC" INTEGER NOT NULL DEFAULT 0,
  "quotedVC" INTEGER,
  "audience" TEXT NOT NULL DEFAULT 'system',
  "usageSource" TEXT NOT NULL DEFAULT 'missing',
  "costSource" TEXT NOT NULL,
  "inputRubPerMillion" DOUBLE PRECISION,
  "outputRubPerMillion" DOUBLE PRECISION,
  "reportedCostRub" DOUBLE PRECISION,
  "providerCostNative" DOUBLE PRECISION,
  "providerCostCurrency" TEXT,
  "usdRub" DOUBLE PRECISION,
  "estimatedCostRub" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AiCostEvent_createdAt_purpose_idx" ON "AiCostEvent"("createdAt", "purpose");
CREATE INDEX "AiCostEvent_operationId_idx" ON "AiCostEvent"("operationId");
CREATE INDEX "AiCostEvent_actorHash_createdAt_idx" ON "AiCostEvent"("actorHash", "createdAt");

CREATE TABLE "AvatarQuotaReservation" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "units" INTEGER NOT NULL,
  "month" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'reserved',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AvatarQuotaReservation_userId_createdAt_idx" ON "AvatarQuotaReservation"("userId", "createdAt");
