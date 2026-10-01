-- Additive analytics metadata for confirmed purchases.
-- Nullable so historical PaymentEvent rows remain valid without backfill.
-- Apply this migration on the target database BEFORE deploying application
-- code that reads or writes planId/amountRub. Do not deploy the reader first.

ALTER TABLE "PaymentEvent" ADD COLUMN IF NOT EXISTS "planId" TEXT;
ALTER TABLE "PaymentEvent" ADD COLUMN IF NOT EXISTS "amountRub" INTEGER;
