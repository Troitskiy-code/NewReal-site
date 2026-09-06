-- CreateIndex
CREATE INDEX IF NOT EXISTS "Character_isPublic_idx" ON "Character"("isPublic");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Character_totalMessages_idx" ON "Character"("totalMessages");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Character_createdAt_idx" ON "Character"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Character_name_idx" ON "Character"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Character_isPublic_createdAt_idx" ON "Character"("isPublic", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Character_isPublic_totalMessages_idx" ON "Character"("isPublic", "totalMessages");
