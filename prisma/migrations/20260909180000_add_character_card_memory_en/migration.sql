-- AlterTable
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "descriptionCard_en" TEXT;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "publicMemory_en" JSONB;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "privateMemory_en" JSONB;

ALTER TABLE "User" ALTER COLUMN "subscriptionType" SET DEFAULT 'start';
