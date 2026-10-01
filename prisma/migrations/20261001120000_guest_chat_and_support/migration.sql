CREATE TABLE IF NOT EXISTS "AnonymousMessage" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transferredAt" TIMESTAMP(3),
  CONSTRAINT "AnonymousMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AnonymousMessage_session_character_created_idx"
  ON "AnonymousMessage"("sessionId", "characterId", "createdAt");

CREATE INDEX IF NOT EXISTS "AnonymousMessage_session_request_idx"
  ON "AnonymousMessage"("sessionId", "requestId");

CREATE TABLE IF NOT EXISTS "AnonymousChatRequest" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "userContent" TEXT NOT NULL,
  "assistantContent" TEXT,
  "userMessageId" TEXT,
  "assistantMessageId" TEXT,
  "remainingMessages" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnonymousChatRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AnonymousChatRequest_session_request_key"
  ON "AnonymousChatRequest"("sessionId", "requestId");

CREATE INDEX IF NOT EXISTS "AnonymousChatRequest_session_created_idx"
  ON "AnonymousChatRequest"("sessionId", "createdAt");

ALTER TABLE "AnonymousSession" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "AnonymousSession" ADD COLUMN IF NOT EXISTS "transferredToUserId" TEXT;
ALTER TABLE "AnonymousSession" ADD COLUMN IF NOT EXISTS "transferredAt" TIMESTAMP(3);

UPDATE "AnonymousSession"
SET "expiresAt" = "createdAt" + INTERVAL '7 days'
WHERE "expiresAt" IS NULL;

CREATE TABLE IF NOT EXISTS "SupportTicket" (
  "id" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "userId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SupportTicket_createdAt_idx" ON "SupportTicket"("createdAt");
CREATE INDEX IF NOT EXISTS "SupportTicket_email_createdAt_idx" ON "SupportTicket"("email", "createdAt");
