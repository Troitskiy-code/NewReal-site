-- Application total window, NOT the provider's native maximum.
-- 16,000 input tokens for Universe + up to 4,000 output/reasoning tokens.
-- Only verified catalog names; preserve prices, IDs, selections and other fields.
UPDATE "Model"
SET "maxContextTokens" = 20000
WHERE "name" IN (
  'deepseek/deepseek-v4-flash',
  'google/gemma-4-31b-it',
  'mistralai/mistral-small-2603',
  'google/gemini-2.5-flash',
  'mistralai/mistral-small-3.1-24b-instruct',
  'anthropic/claude-haiku-4.5',
  'x-ai/grok-4.20',
  'openai/gpt-5.1',
  'mistralai/mistral-large-2407',
  'xiaomi/mimo-v2.6-flash',
  'sao10k/l3.3-euryale-70b',
  'sao10k/l3.1-euryale-70b',
  'aion-labs/aion-3.0-mini',
  'aion-labs/aion-3.5-mini'
);
