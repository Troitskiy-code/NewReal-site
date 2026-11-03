-- Nullable, additive storage. Historical messages and stories need no backfill.
ALTER TABLE "Message" ADD COLUMN "speechRecognition" JSONB;
ALTER TABLE "ChatThread" ADD COLUMN "speechCast" JSONB;
