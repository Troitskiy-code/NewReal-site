ALTER TABLE "AvatarQuotaReservation"
  ADD COLUMN "chargedVC" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "chargedFromPermanent" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "chargedSubscriptionEnd" TIMESTAMP(3),
  ADD COLUMN "chargedNextVCAt" TIMESTAMP(3),
  ADD CONSTRAINT "AvatarQuotaReservation_valid_charge" CHECK (
    "chargedVC" >= 0 AND "chargedFromPermanent" BETWEEN 0 AND "chargedVC"
    AND ("chargedVC" = 0 OR "units" = 0)
  );
