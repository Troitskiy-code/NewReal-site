-- Hide six DeepInfra chat models that failed the 2026-10-16 RU/EN review
-- (docs/deepinfra-adult-roleplay-selection-2026-10-16.md). Data only; no schema changes.
-- Apply ONLY AFTER the code that makes Gemma 4 31B Turbo the base model is deployed:
-- older code still resolves Mistral Small as the base and would find no active base model.
-- Rows, IDs, prices and User.selectedModelId are kept; such selections fall back to the base model.
-- Rollback: set "isActive" = true for the same names.
UPDATE "Model" SET "isActive" = false
WHERE "name" IN (
  'deepinfra:mistralai/Mistral-Small-3.2-24B-Instruct-2506',
  'deepinfra:meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'deepinfra:Sao10K/L3.1-70B-Euryale-v2.2',
  'deepinfra:XiaomiMiMo/MiMo-V2.6-Flash',
  'deepinfra:google/gemini-2.5-flash',
  'deepinfra:NousResearch/Hermes-3-Llama-3.1-70B'
);
