-- Replace experimental selection with seven new candidates and retained Aion 3.5 Mini.
-- Preserve model IDs, histories, prices of ordinary models and User.selectedModelId.
-- RUB rates are fixed catalog estimates at 96.7 RUB/USD, not measured provider debits.
INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput",
  "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive")
VALUES
  ('testing_cydonia_24b_v41', 'thedrummer/cydonia-24b-v4.1', 'Cydonia 24B V4.1', 29.01, 48.35, 9, 20000,
    'Тестовая модель для персонажей и творческих сюжетов. Проверяем русский язык, удержание роли и разнообразие текста.', false, true),
  ('testing_venice_uncensored_24b', 'cognitivecomputations/dolphin-mistral-24b-venice-edition', 'Venice Uncensored 24B', 19.34, 87.03, 7, 20000,
    'Тестовая модель для свободного творческого письма. Качество ролевых диалогов и русского языка ещё оцениваем.', false, true),
  ('testing_unslopnemo_12b', 'thedrummer/unslopnemo-12b', 'UnslopNemo 12B', 38.68, 38.68, 11, 20000,
    'Лёгкая тестовая модель для приключений и ролевых сцен. Проверяем связность длинного диалога.', false, true),
  ('testing_skyfall_36b_v2', 'thedrummer/skyfall-36b-v2', 'Skyfall 36B V2', 53.19, 77.36, 16, 20000,
    'Тестовая модель для выразительной прозы и последовательного развития сюжета.', false, true),
  ('testing_aion_rp_10', 'aion-labs/aion-rp-llama-3.1-8b', 'Aion-RP 1.0 (8B)', 77.36, 154.72, 24, 20000,
    'Специализированная тестовая модель для ролевых диалогов. Проверяем русский язык и устойчивость персонажа.', false, true),
  ('testing_aion_20', 'aion-labs/aion-2.0', 'Aion 2.0', 77.36, 154.72, 24, 20000,
    'Тестовая модель для сюжетных конфликтов и эмоциональных сцен. Запрашиваем отключение рассуждений; работу режима через шлюз ещё проверяем.', false, true),
  ('testing_hermes_3_405b', 'nousresearch/hermes-3-llama-3.1-405b', 'Hermes 3 405B', 96.7, 96.7, 28, 20000,
    'Тестовая модель для сложных персонажей и длинных диалогов. Ответ может занимать больше времени.', false, true),
  ('testing_aion_35_mini', 'aion-labs/aion-3.5-mini', 'Aion 3.5 Mini', 67.69, 135.38, 38, 20000,
    'Модель для ролевых сцен с обязательными рассуждениями. Сохраняем как ориентир качества по результатам пользовательских тестов; расход ещё измеряется.', false, true)
ON CONFLICT ("name") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "pricePer1MInput" = EXCLUDED."pricePer1MInput",
  "pricePer1MOutput" = EXCLUDED."pricePer1MOutput",
  "priceVC" = EXCLUDED."priceVC",
  "maxContextTokens" = EXCLUDED."maxContextTokens",
  "description" = EXCLUDED."description",
  "isFreeForSubscribers" = EXCLUDED."isFreeForSubscribers",
  "isActive" = EXCLUDED."isActive";

-- Soft retirement: preserve existing IDs and selections; runtime falls back to the base model.
UPDATE "Model" SET "isActive" = false
WHERE "name" IN ('xiaomi/mimo-v2.6-flash', 'sao10k/l3.3-euryale-70b',
  'sao10k/l3.1-euryale-70b', 'aion-labs/aion-3.0-mini');
