-- AlterTable
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "totalMessages" INTEGER NOT NULL DEFAULT 0;

-- Backfill: current messages across all users. After this the counter only increases.
UPDATE "Character" AS c
SET "totalMessages" = (
  SELECT COUNT(*)::integer FROM "Message" AS m WHERE m."characterId" = c."id"
);
