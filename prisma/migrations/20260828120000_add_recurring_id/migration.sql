-- AlterTable: parent Robokassa invoice id for recurring subscription charges.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'robokassaRecurringId'
  ) THEN
    ALTER TABLE "User" ADD COLUMN "robokassaRecurringId" TEXT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "User_robokassaRecurringId_key" ON "User"("robokassaRecurringId");
