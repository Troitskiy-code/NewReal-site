-- AlterTable
ALTER TABLE "Character" ADD COLUMN "slug" TEXT;

UPDATE "Character" SET "slug" = 'c-' || "id" WHERE "slug" IS NULL;

ALTER TABLE "Character" ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX "Character_slug_key" ON "Character"("slug");
