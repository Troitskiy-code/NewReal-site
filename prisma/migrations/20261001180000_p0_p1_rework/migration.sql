-- Guest request fencing, payment uniqueness, support outbox.
-- Additive only; does not delete user data.

ALTER TABLE "AnonymousChatRequest" ADD COLUMN IF NOT EXISTS "payloadHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AnonymousChatRequest" ADD COLUMN IF NOT EXISTS "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AnonymousChatRequest" ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);
ALTER TABLE "AnonymousChatRequest" ADD COLUMN IF NOT EXISTS "reservedQuota" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AnonymousChatRequest" ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "AnonymousChatRequest_status_leaseUntil_idx"
  ON "AnonymousChatRequest"("status", "leaseUntil");

CREATE TABLE IF NOT EXISTS "PaymentEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvent_provider_invoiceId_key"
  ON "PaymentEvent"("provider", "invoiceId");
CREATE INDEX IF NOT EXISTS "PaymentEvent_userId_idx" ON "PaymentEvent"("userId");

INSERT INTO "PaymentEvent" ("id", "provider", "invoiceId", "userId", "kind", "createdAt")
SELECT
  md5("id"),
  'robokassa',
  regexp_replace("description", '^Robokassa InvId=', ''),
  "userId",
  "type",
  "createdAt"
FROM "Transaction"
WHERE "description" LIKE 'Robokassa InvId=%'
ON CONFLICT ("provider", "invoiceId") DO NOTHING;

ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "clientKey" TEXT;
ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "payloadHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);
ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "claimToken" TEXT;
ALTER TABLE "SupportTicket" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "SupportTicket_clientKey_key" ON "SupportTicket"("clientKey");
CREATE INDEX IF NOT EXISTS "SupportTicket_delivery_next_idx"
  ON "SupportTicket"("deliveryStatus", "nextAttemptAt");
