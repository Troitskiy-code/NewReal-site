-- Permanent VC (purchased / daily bonus) vs expiring subscription VC.
-- verseCoins remains the total: permanentCoins + expiringCoins.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'permanentCoins'
  ) THEN
    ALTER TABLE "User" ADD COLUMN "permanentCoins" INTEGER NOT NULL DEFAULT 0;
    UPDATE "User" SET "permanentCoins" = "verseCoins";
  END IF;
END $$;
