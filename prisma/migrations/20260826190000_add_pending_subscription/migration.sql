-- AlterTable: pending subscription fields for deferred plan changes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'pendingSubscriptionType'
  ) THEN
    ALTER TABLE "User" ADD COLUMN "pendingSubscriptionType" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'pendingSubscriptionEnd'
  ) THEN
    ALTER TABLE "User" ADD COLUMN "pendingSubscriptionEnd" TIMESTAMP(3);
  END IF;
END $$;
