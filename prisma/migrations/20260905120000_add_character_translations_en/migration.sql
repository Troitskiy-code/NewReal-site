-- AlterTable
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "name_en" TEXT;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "description_en" TEXT;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "appearance_en" TEXT;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "greeting_en" TEXT;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "scenario_en" TEXT;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "exampleDialogs_en" TEXT;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "avatarPrompt_en" TEXT;
