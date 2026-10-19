CREATE TABLE "SpeechClip" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "messageId" TEXT NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "voice" TEXT NOT NULL,
  "inputCharacters" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "audio" BYTEA,
  "requestToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "SpeechClip_userId_status_leaseUntil_idx" ON "SpeechClip"("userId", "status", "leaseUntil");
CREATE INDEX "SpeechClip_userId_expiresAt_idx" ON "SpeechClip"("userId", "expiresAt");
CREATE INDEX "SpeechClip_expiresAt_idx" ON "SpeechClip"("expiresAt");
CREATE TABLE "SpeechDailyQuota" (
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "day" TEXT NOT NULL,
  "used" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("userId", "day")
);
CREATE INDEX "SpeechDailyQuota_day_idx" ON "SpeechDailyQuota"("day");
