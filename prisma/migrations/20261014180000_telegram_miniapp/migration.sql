-- Telegram Mini App. Additive: four new tables, existing tables are not altered.
-- Safe to execute again: every statement is guarded (IF NOT EXISTS, DROP CONSTRAINT IF EXISTS).
-- Comments contain no semicolons, so Adminer can split the file statement by statement.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS "TelegramAccount" (
  "id" TEXT NOT NULL,
  "telegramId" TEXT NOT NULL,
  "userId" TEXT,
  "origin" TEXT NOT NULL DEFAULT 'telegram',
  "linkedAt" TIMESTAMP(3),
  "unlinkedAt" TIMESTAMP(3),
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelegramAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramAccount_telegramId_key" ON "TelegramAccount"("telegramId");
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramAccount_userId_key" ON "TelegramAccount"("userId");
ALTER TABLE "TelegramAccount" DROP CONSTRAINT IF EXISTS "TelegramAccount_userId_fkey";
ALTER TABLE "TelegramAccount" ADD CONSTRAINT "TelegramAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "TelegramLinkToken" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TelegramLinkToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramLinkToken_tokenHash_key" ON "TelegramLinkToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "TelegramLinkToken_userId_createdAt_idx" ON "TelegramLinkToken"("userId", "createdAt");
ALTER TABLE "TelegramLinkToken" DROP CONSTRAINT IF EXISTS "TelegramLinkToken_userId_fkey";
ALTER TABLE "TelegramLinkToken" ADD CONSTRAINT "TelegramLinkToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "TelegramInitDataReceipt" (
  "hash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TelegramInitDataReceipt_pkey" PRIMARY KEY ("hash")
);
CREATE INDEX IF NOT EXISTS "TelegramInitDataReceipt_expiresAt_idx" ON "TelegramInitDataReceipt"("expiresAt");

CREATE TABLE IF NOT EXISTS "TelegramCatalogEntry" (
  "characterId" TEXT NOT NULL,
  "addedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TelegramCatalogEntry_pkey" PRIMARY KEY ("characterId")
);
ALTER TABLE "TelegramCatalogEntry" DROP CONSTRAINT IF EXISTS "TelegramCatalogEntry_characterId_fkey";
ALTER TABLE "TelegramCatalogEntry" ADD CONSTRAINT "TelegramCatalogEntry_characterId_fkey"
  FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;
