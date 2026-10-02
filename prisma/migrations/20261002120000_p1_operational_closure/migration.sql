-- Apply before deploying the P1 code. Run with a migration role, never the app role.
CREATE TABLE IF NOT EXISTS "RateLimitBucket" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "count" INTEGER NOT NULL,
  "resetAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");

-- Old pending claims already reserved a guest request. Preserve that reservation
-- and make them retryable without charging twice; do not guess a refund.
-- New fenced claims (nonempty hash) and completed answers remain untouched.
UPDATE "AnonymousChatRequest" SET
  "reservedQuota" = CASE WHEN "status" IN ('pending', 'completed') THEN true ELSE "reservedQuota" END,
  "status" = CASE WHEN "status" = 'pending' THEN 'failed' ELSE "status" END,
  "leaseUntil" = NULL,
  "payloadHash" = encode(sha256(convert_to("characterId" || E'\n' || "userContent", 'UTF8')), 'hex')
WHERE "payloadHash" = '';

-- Legacy email delivery was outside the outbox. Resending might duplicate it.
UPDATE "SupportTicket" SET "deliveryStatus" = 'manual_review',
  "lastError" = 'legacy_delivery_unknown', "nextAttemptAt" = NULL
WHERE "clientKey" IS NULL AND "deliveryStatus" = 'pending' AND "deliveryAttempts" = 0;

-- Older additive migrations did not create these relations. Orphans cause a
-- migration failure for operator review; user data is never silently deleted.
DO $$ BEGIN
  ALTER TABLE "AnonymousMessage" ADD CONSTRAINT "AnonymousMessage_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "AnonymousSession"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AnonymousChatRequest" ADD CONSTRAINT "AnonymousChatRequest_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "AnonymousSession"("sessionId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "AnonymousChatRequest_sessionId_requestId_key"
  ON "AnonymousChatRequest"("sessionId", "requestId");
CREATE INDEX IF NOT EXISTS "AnonymousChatRequest_sessionId_createdAt_idx"
  ON "AnonymousChatRequest"("sessionId", "createdAt");
CREATE INDEX IF NOT EXISTS "AnonymousMessage_sessionId_characterId_createdAt_idx"
  ON "AnonymousMessage"("sessionId", "characterId", "createdAt");
CREATE INDEX IF NOT EXISTS "AnonymousMessage_sessionId_requestId_idx"
  ON "AnonymousMessage"("sessionId", "requestId");
CREATE INDEX IF NOT EXISTS "SupportTicket_deliveryStatus_nextAttemptAt_idx"
  ON "SupportTicket"("deliveryStatus", "nextAttemptAt");
