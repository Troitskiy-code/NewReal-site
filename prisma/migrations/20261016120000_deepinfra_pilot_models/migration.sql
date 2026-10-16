-- Pilot of the 2026-10-16 DeepInfra selection: seven new chat models, all marked testing in
-- src/lib/data/deepinfra-chat-models-2026-10-11.json. Data only; no schema changes.
-- Evidence: docs/deepinfra-adult-roleplay-selection-2026-10-16.md.
-- Safe in either order with the code deploy: old code lists only its own catalogue names,
-- and new code shows only names that exist here. Run the whole file in one transaction after a fresh backup.
-- RUB catalogue quotes use 108.192 RUB / credited USD at undiscounted Standard prices; runtime accounting uses DEEPINFRA_USD_RUB.
-- Existing models, IDs and User.selectedModelId are untouched.

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261016_01', 'deepinfra:Qwen/Qwen3-Next-80B-A3B-Instruct', 'Qwen3-Next 80B Instruct', 9.73728, 119.0112, 6, 20000, 'Яркая образная проза для коротких сцен. Новая модель проходит проверку.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261016_02', 'deepinfra:deepseek-ai/DeepSeek-V4.1-Flash', 'DeepSeek V4.1 Flash', 21.6384, 64.9152, 8, 20000, 'Быстрые живые ответы. Новая версия DeepSeek проходит проверку.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261016_03', 'deepinfra:google/gemma-4-31B-it-Ultra', 'Gemma 4 31B Ultra', 29.21184, 82.22592, 10, 20000, 'Ровные ответы для длинных историй на стабильном маршруте Gemma 4. Проходит проверку.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261016_04', 'deepinfra:meta-models/Muse-Glimmer-30B', 'Muse Glimmer 30B', 32.4576, 129.8304, 12, 20000, 'Очень быстрые ответы и точный тон персонажа. Новая модель проходит проверку.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261016_05', 'deepinfra:XiaomiMiMo/MiMo-V2.6-Pro', 'MiMo V2.6 Pro', 46.52256, 94.12704, 15, 20000, 'Хорошо помнит детали истории; ответ может занять до 15 секунд. Проходит проверку.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261016_06', 'deepinfra:zai-org/GLM-5.2', 'GLM-5.2', 81.144, 259.6608, 26, 20000, 'Естественная речь и строгое следование договорённостям сюжета. Проходит проверку.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261016_07', 'deepinfra:moonshotai/Kimi-K2.6', 'Kimi K2.6', 81.144, 378.672, 27, 20000, 'Для длинных историй: лучше всех помнит детали и держит характер. Проходит проверку.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;
