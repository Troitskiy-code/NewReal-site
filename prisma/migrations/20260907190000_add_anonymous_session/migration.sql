CREATE TABLE IF NOT EXISTS "AnonymousSession" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "messagesCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AnonymousSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AnonymousSession_sessionId_key" ON "AnonymousSession"("sessionId");
