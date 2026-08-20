CREATE INDEX IF NOT EXISTS idx_message_embedding
  ON "MessageEmbedding"
  USING ivfflat (embedding vector_cosine_ops);
