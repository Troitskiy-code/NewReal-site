CREATE TABLE "CharacterTranslation" (
  "characterId" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "name" TEXT,
  "description" TEXT,
  "descriptionCard" TEXT,
  "appearance" TEXT,
  "greeting" TEXT,
  "scenario" TEXT,
  "exampleDialogs" TEXT,
  "avatarPrompt" TEXT,
  "publicMemory" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CharacterTranslation_pkey" PRIMARY KEY ("characterId", "locale"),
  CONSTRAINT "CharacterTranslation_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CharacterTranslation_locale_idx" ON "CharacterTranslation"("locale");
