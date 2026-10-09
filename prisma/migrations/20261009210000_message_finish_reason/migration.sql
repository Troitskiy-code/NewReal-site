-- Apply before deploying the Prisma Client/code that reads Message.finishReason.
-- Existing messages remain NULL: punctuation cannot establish provider finish_reason.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "finishReason" TEXT;
