-- AlterTable
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "slug" TEXT;

UPDATE "Character" SET "slug" = 'c-' || "id" WHERE "slug" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Character_slug_key" ON "Character"("slug");
