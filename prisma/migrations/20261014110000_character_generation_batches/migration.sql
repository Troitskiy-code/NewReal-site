CREATE TABLE "CharacterGenerationBatch" (
  "id" TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "clientKey" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'running',
  "budgetKopecks" INTEGER NOT NULL CHECK ("budgetKopecks" > 0 AND "budgetKopecks" <= 20000),
  "spentKopecks" INTEGER NOT NULL DEFAULT 0 CHECK ("spentKopecks" >= 0),
  "reservedKopecks" INTEGER NOT NULL DEFAULT 0 CHECK ("reservedKopecks" >= 0),
  "prices" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("ownerId", "clientKey")
);
CREATE INDEX "CharacterGenerationBatch_state_createdAt_idx" ON "CharacterGenerationBatch"("state", "createdAt");
CREATE TABLE "CharacterGenerationItem" (
  "id" TEXT PRIMARY KEY, "batchId" TEXT NOT NULL REFERENCES "CharacterGenerationBatch"("id") ON DELETE CASCADE,
  "themeKey" TEXT NOT NULL, "position" INTEGER NOT NULL, "state" TEXT NOT NULL DEFAULT 'queued', "stage" TEXT NOT NULL DEFAULT 'text',
  "card" JSONB, "feedback" TEXT, "translations" JSONB, "imageUrl" TEXT, "providerTaskId" TEXT UNIQUE,
  "characterId" TEXT UNIQUE REFERENCES "Character"("id") ON DELETE SET NULL,
  "errorCode" TEXT, "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3), "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("batchId", "themeKey")
);
CREATE INDEX "CharacterGenerationItem_state_nextRunAt_leaseUntil_idx" ON "CharacterGenerationItem"("state", "nextRunAt", "leaseUntil");
CREATE TABLE "CharacterGenerationAttempt" (
  "id" TEXT PRIMARY KEY, "itemId" TEXT NOT NULL REFERENCES "CharacterGenerationItem"("id") ON DELETE CASCADE,
  "stage" TEXT NOT NULL, "number" INTEGER NOT NULL, "state" TEXT NOT NULL DEFAULT 'reserved',
  "reservedKopecks" INTEGER NOT NULL CHECK ("reservedKopecks" > 0), "chargedKopecks" INTEGER NOT NULL DEFAULT 0 CHECK ("chargedKopecks" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("itemId", "stage", "number")
);
