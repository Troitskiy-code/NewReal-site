-- AlterTable
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "lastActive" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "privateMemory" JSONB;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "publicMemory" JSONB;
ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "memoryPermissions" JSONB;

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorldEvent" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "participants" TEXT[] NOT NULL,
    "description" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importance" INTEGER NOT NULL DEFAULT 1,
    "location" TEXT,

    CONSTRAINT "WorldEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorldEvent_characterId_idx" ON "WorldEvent"("characterId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorldEvent_characterId_timestamp_idx" ON "WorldEvent"("characterId", "timestamp");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "WorldEvent" ADD CONSTRAINT "WorldEvent_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
