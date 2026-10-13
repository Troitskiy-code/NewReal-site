-- The production cards/states were already converted before this release.
-- Preserve every stored prompt, archive, message and migration snapshot.
ALTER TABLE "Character" ALTER COLUMN "promptBuilderVersion" SET DEFAULT 2;
ALTER TABLE "ChatPromptState" ALTER COLUMN "builderVersion" SET DEFAULT 2;
