-- Additive only. Apply BEFORE the new Prisma client/code. No mass prompt conversion.
ALTER TABLE "Character"
  ADD COLUMN "legacyPromptArchive" TEXT,
  ADD COLUMN "promptOrigin" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "promptBuilderVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "roleplayMode" TEXT NOT NULL DEFAULT 'character',
  ADD COLUMN "roleplayStyle" TEXT NOT NULL DEFAULT 'mixed',
  ADD COLUMN "rpConfig" JSONB;

CREATE TABLE "ChatPromptState" (
  "id" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "characterId" TEXT NOT NULL,
  "builderVersion" INTEGER NOT NULL DEFAULT 1,
  "mode" TEXT NOT NULL DEFAULT 'character',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatPromptState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatPromptState_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ChatPromptState_scopeKey_characterId_key" ON "ChatPromptState"("scopeKey", "characterId");
