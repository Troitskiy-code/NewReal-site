-- Apply before deploying code using SupportReply. No existing tickets are changed.
CREATE TABLE "SupportReply" (
 "id" TEXT NOT NULL, "ticketId" TEXT NOT NULL, "clientKey" TEXT NOT NULL,
 "payloadHash" TEXT NOT NULL, "recipient" TEXT NOT NULL, "sender" TEXT NOT NULL,
 "message" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
 "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
 "claimedAt" TIMESTAMP(3), "claimToken" TEXT, "providerId" TEXT,
 "acceptedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "SupportReply_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "SupportReply_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SupportReply_clientKey_key" ON "SupportReply"("clientKey");
CREATE INDEX "SupportReply_ticketId_createdAt_idx" ON "SupportReply"("ticketId", "createdAt");
CREATE INDEX "SupportReply_status_nextAttemptAt_idx" ON "SupportReply"("status", "nextAttemptAt");
