-- Apply this scoped SQL BEFORE releasing code using AvatarGeneration.
-- Existing users, characters, quota reservations and migration history are preserved.
CREATE TABLE "AvatarGeneration" (
  "id" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientKey" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'creating',
  "providerTaskId" TEXT,
  "imageUrl" TEXT,
  "errorCode" TEXT,
  "credits" DOUBLE PRECISION,
  "creditRub" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "estimatedCredits" DOUBLE PRECISION NOT NULL,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "nextPollAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AvatarGeneration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AvatarGeneration_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "AvatarQuotaReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AvatarGeneration_reservationId_key" ON "AvatarGeneration"("reservationId");
CREATE UNIQUE INDEX "AvatarGeneration_providerTaskId_key" ON "AvatarGeneration"("providerTaskId");
CREATE UNIQUE INDEX "AvatarGeneration_userId_clientKey_key" ON "AvatarGeneration"("userId", "clientKey");
CREATE INDEX "AvatarGeneration_userId_scope_createdAt_idx" ON "AvatarGeneration"("userId", "scope", "createdAt");
CREATE INDEX "AvatarGeneration_state_nextPollAt_idx" ON "AvatarGeneration"("state", "nextPollAt");
