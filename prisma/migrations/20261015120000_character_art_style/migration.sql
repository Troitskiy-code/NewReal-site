-- Additive and nullable: safe to apply before deploying the code that reads it.
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "artStyle" TEXT;
