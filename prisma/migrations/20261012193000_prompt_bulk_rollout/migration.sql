-- Apply before deploying this Prisma Client. Does not convert cards or histories.
ALTER TABLE "ChatPromptState" ADD COLUMN IF NOT EXISTS "promptMigrationId" TEXT;
CREATE INDEX IF NOT EXISTS "ChatPromptState_characterId_builderVersion_idx" ON "ChatPromptState"("characterId", "builderVersion");
CREATE TABLE IF NOT EXISTS "PromptRollout" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "finalized" BOOLEAN NOT NULL DEFAULT false,
  "finalizedAt" TIMESTAMP(3)
);
INSERT INTO "PromptRollout" ("id") VALUES ('rp-v2') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS "PromptMigrationEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "characterId" TEXT NOT NULL REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'reviewed',
  "sourceFingerprint" TEXT NOT NULL,
  "afterFingerprint" TEXT,
  "before" JSONB NOT NULL,
  "proposal" JSONB NOT NULL,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3),
  "rolledBackAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "PromptMigrationEntry_characterId_status_idx" ON "PromptMigrationEntry"("characterId", "status");
CREATE INDEX IF NOT EXISTS "PromptMigrationEntry_status_reviewedAt_idx" ON "PromptMigrationEntry"("status", "reviewedAt");
-- One applied conversion per card, including concurrent/replayed requests.
CREATE UNIQUE INDEX IF NOT EXISTS "PromptMigrationEntry_active_card_idx" ON "PromptMigrationEntry"("characterId") WHERE "status" = 'applied';
CREATE TABLE IF NOT EXISTS "PromptMigrationStory" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "entryId" TEXT NOT NULL REFERENCES "PromptMigrationEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "scopeKey" TEXT NOT NULL,
  "builderVersion" INTEGER NOT NULL,
  "mode" TEXT NOT NULL,
  "previousMigrationId" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "PromptMigrationStory_entryId_scopeKey_key" ON "PromptMigrationStory"("entryId", "scopeKey");
