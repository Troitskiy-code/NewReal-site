-- AlterTable: rename daily avatar usage fields to monthly, or add them if missing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'tokensUsedToday'
  ) THEN
    ALTER TABLE "User" RENAME COLUMN "tokensUsedToday" TO "tokensUsedThisMonth";
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'tokensUsedThisMonth'
  ) THEN
    ALTER TABLE "User" ADD COLUMN "tokensUsedThisMonth" INTEGER NOT NULL DEFAULT 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'lastTokenDate'
  ) THEN
    ALTER TABLE "User" RENAME COLUMN "lastTokenDate" TO "lastTokenMonth";
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'lastTokenMonth'
  ) THEN
    ALTER TABLE "User" ADD COLUMN "lastTokenMonth" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
  END IF;
END $$;
