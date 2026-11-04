ALTER TABLE "ChatThread" ADD COLUMN "speechVoices" JSONB;
CREATE TABLE "SpeechClipPart" (
  "id" TEXT NOT NULL,
  "clipId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'idle',
  "turns" JSONB NOT NULL,
  "providerTaskId" TEXT,
  "costEventId" TEXT,
  "pcm" BYTEA,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpeechClipPart_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SpeechClipPart_clipId_fkey" FOREIGN KEY ("clipId") REFERENCES "SpeechClip"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SpeechClipPart_clipId_position_key" ON "SpeechClipPart"("clipId", "position");
