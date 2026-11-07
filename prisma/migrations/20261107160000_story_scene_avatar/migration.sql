ALTER TABLE "ChatThread" ADD COLUMN "sceneAvatarJobId" TEXT;

CREATE INDEX "ChatThread_sceneAvatarJobId_idx" ON "ChatThread"("sceneAvatarJobId");

ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_sceneAvatarJobId_fkey"
  FOREIGN KEY ("sceneAvatarJobId") REFERENCES "AvatarGeneration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
