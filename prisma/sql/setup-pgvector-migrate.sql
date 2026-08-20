CREATE EXTENSION IF NOT EXISTS vector;

TRUNCATE TABLE "MessageEmbedding";

ALTER TABLE "MessageEmbedding" DROP COLUMN IF EXISTS embedding;
ALTER TABLE "MessageEmbedding" ADD COLUMN embedding vector(1536) NOT NULL;
