-- CreateIndex
CREATE INDEX IF NOT EXISTS "Character_userId_idx" ON "Character"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Character_userId_createdAt_idx" ON "Character"("userId", "createdAt");
