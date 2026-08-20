-- Enable pgvector and migrate MessageEmbedding.embedding to vector(1536)
CREATE EXTENSION IF NOT EXISTS vector;

TRUNCATE TABLE "MessageEmbedding";

ALTER TABLE "MessageEmbedding" DROP COLUMN IF EXISTS embedding;
ALTER TABLE "MessageEmbedding" ADD COLUMN embedding vector(1536) NOT NULL;

-- IVFFlat требует данных в таблице; при ошибке создайте индекс после накопления эмбеддингов
CREATE INDEX IF NOT EXISTS idx_message_embedding
  ON "MessageEmbedding"
  USING ivfflat (embedding vector_cosine_ops);
