-- AlterTable
ALTER TABLE "WorldEvent" ADD COLUMN IF NOT EXISTS "initiatorId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorldEvent_initiatorId_idx" ON "WorldEvent"("initiatorId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Character_lastActive_idx" ON "Character"("lastActive");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "WorldEvent" ADD CONSTRAINT "WorldEvent_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
