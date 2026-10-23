-- Approved 2026-10-20: implement docs/model-economy-price-options-2026-10-16.md.
-- Data only: seven prices; IDs, availability, provider cost rates and user balances are unchanged.
-- Re-applying is safe. Unexpected existing prices or missing rows abort the whole operation.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $pricing$
DECLARE
  matched integer;
BEGIN
  -- Lock just the seven affected catalogue rows until the transaction completes.
  PERFORM 1 FROM "Model"
  WHERE "name" IN (
    'deepinfra:Qwen/Qwen3-Next-80B-A3B-Instruct',
    'deepinfra:deepseek-ai/DeepSeek-V4.1-Flash',
    'deepinfra:google/gemma-4-31B-it-Ultra',
    'deepinfra:meta-models/Muse-Glimmer-30B',
    'deepinfra:XiaomiMiMo/MiMo-V2.6-Pro',
    'deepinfra:zai-org/GLM-5.2',
    'deepinfra:moonshotai/Kimi-K2.6'
  ) FOR UPDATE;
  SELECT count(*) INTO matched
  FROM "Model" m
  JOIN (VALUES
      ('deepinfra:Qwen/Qwen3-Next-80B-A3B-Instruct', 6, 7),
      ('deepinfra:deepseek-ai/DeepSeek-V4.1-Flash', 8, 10),
      ('deepinfra:google/gemma-4-31B-it-Ultra', 10, 12),
      ('deepinfra:meta-models/Muse-Glimmer-30B', 12, 14),
      ('deepinfra:XiaomiMiMo/MiMo-V2.6-Pro', 15, 18),
      ('deepinfra:zai-org/GLM-5.2', 26, 31),
      ('deepinfra:moonshotai/Kimi-K2.6', 27, 33)
  ) AS p(name, old_vc, new_vc) ON m."name" = p.name
  WHERE m."priceVC" IN (p.old_vc, p.new_vc);
  IF matched <> 7 THEN
    RAISE EXCEPTION 'Price migration aborted: missing model or unexpected price (matched %/7)', matched;
  END IF;

  UPDATE "Model" m SET "priceVC" = p.new_vc
  FROM (VALUES
      ('deepinfra:Qwen/Qwen3-Next-80B-A3B-Instruct', 6, 7),
      ('deepinfra:deepseek-ai/DeepSeek-V4.1-Flash', 8, 10),
      ('deepinfra:google/gemma-4-31B-it-Ultra', 10, 12),
      ('deepinfra:meta-models/Muse-Glimmer-30B', 12, 14),
      ('deepinfra:XiaomiMiMo/MiMo-V2.6-Pro', 15, 18),
      ('deepinfra:zai-org/GLM-5.2', 26, 31),
      ('deepinfra:moonshotai/Kimi-K2.6', 27, 33)
  ) AS p(name, old_vc, new_vc)
  WHERE m."name" = p.name AND m."priceVC" = p.old_vc;

  SELECT count(*) INTO matched
  FROM "Model" m
  JOIN (VALUES
      ('deepinfra:Qwen/Qwen3-Next-80B-A3B-Instruct', 6, 7),
      ('deepinfra:deepseek-ai/DeepSeek-V4.1-Flash', 8, 10),
      ('deepinfra:google/gemma-4-31B-it-Ultra', 10, 12),
      ('deepinfra:meta-models/Muse-Glimmer-30B', 12, 14),
      ('deepinfra:XiaomiMiMo/MiMo-V2.6-Pro', 15, 18),
      ('deepinfra:zai-org/GLM-5.2', 26, 31),
      ('deepinfra:moonshotai/Kimi-K2.6', 27, 33)
  ) AS p(name, old_vc, new_vc) ON m."name" = p.name
  WHERE m."priceVC" = p.new_vc;
  IF matched <> 7 THEN
    RAISE EXCEPTION 'Price migration verification failed';
  END IF;
END
$pricing$;
COMMIT;
