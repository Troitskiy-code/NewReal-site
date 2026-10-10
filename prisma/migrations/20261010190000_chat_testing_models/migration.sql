-- Add/update only the five experimental models; preserve existing model IDs and selections.
-- Rates are the owner's RUB catalog snapshot (10 October), not measured provider debits.
INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput",
  "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive")
VALUES
  ('testing_mimo_v26_flash', 'xiaomi/mimo-v2.6-flash', 'MiMo V2.6 Flash', 13.54, 27.07, 4, 20000,
    'Тестовая модель для диалогов и развития сюжета. Оцениваем качество русского языка и скорость ответов.', false, true),
  ('testing_euryale_33', 'sao10k/l3.3-euryale-70b', 'Euryale 3.3', 62.86, 72.53, 18, 20000,
    'Модель для ролевых диалогов и характеров персонажей. Скорость ответа может быть ниже привычной.', false, true),
  ('testing_euryale_31', 'sao10k/l3.1-euryale-70b', 'Euryale 3.1', 82.20, 82.20, 23, 20000,
    'Предыдущая версия Euryale для сравнения стиля и поведения персонажей. Скорость ответа может быть ниже привычной.', false, true),
  ('testing_aion_30_mini', 'aion-labs/aion-3.0-mini', 'Aion 3.0 Mini', 67.69, 135.38, 22, 20000,
    'Тестовая модель для ролевых сцен. Запрашиваем режим без рассуждений, но его поддержку через шлюз ещё проверяем. Ответ может оказаться коротким или не завершиться.', false, true),
  ('testing_aion_35_mini', 'aion-labs/aion-3.5-mini', 'Aion 3.5 Mini', 67.69, 135.38, 38, 20000,
    'Тестовая модель для ролевых сцен с обязательными рассуждениями. Может отвечать дольше; качество и фактические расходы ещё проверяются.', false, true)
ON CONFLICT ("name") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "pricePer1MInput" = EXCLUDED."pricePer1MInput",
  "pricePer1MOutput" = EXCLUDED."pricePer1MOutput",
  "priceVC" = EXCLUDED."priceVC",
  "maxContextTokens" = EXCLUDED."maxContextTokens",
  "description" = EXCLUDED."description",
  "isFreeForSubscribers" = EXCLUDED."isFreeForSubscribers",
  "isActive" = EXCLUDED."isActive";
