-- Apply before enabling CHAT_AI_PROVIDER=deepinfra. Data only; no schema changes.
-- FIRST deploy provider-aware catalogue filtering with CHAT_AI_PROVIDER=kodikrouter.
-- Run the entire file in a single transaction after a fresh production backup.
-- Namespaced names preserve every Kodik row and existing selectedModelId.
-- RUB catalogue quotes use 108.192 RUB / credited USD; runtime accounting uses DEEPINFRA_USD_RUB.

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261011_01', 'deepinfra:mistralai/Mistral-Small-3.2-24B-Instruct-2506', 'Mistral Small 3.2 24B', 8.1144, 21.6384, 4, 20000, 'Для повседневного общения и знакомства с персонажем.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261011_02', 'deepinfra:google/gemma-4-31B-it-turbo', 'Gemma 4 31B Turbo', 9.73728, 36.78528, 5, 20000, 'Универсальная модель для диалогов и развития истории.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261011_03', 'deepinfra:Qwen/Qwen3-235B-A22B-Instruct-2507', 'Qwen3 235B Instruct 2507', 9.73728, 59.5056, 6, 20000, 'Для подробных сцен и следования заданному сценарию.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261011_04', 'deepinfra:deepseek-ai/DeepSeek-V4-Flash-0731', 'DeepSeek V4 Flash 0731', 6.49152, 19.47456, 4, 20000, 'Новая версия DeepSeek для диалогов. Режим без рассуждений проходит проверку.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261011_05', 'deepinfra:meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Llama 3.3 70B Turbo', 10.8192, 34.62144, 5, 20000, 'Для общения с персонажем и совместного рассказа.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261011_06', 'deepinfra:Sao10K/L3.1-70B-Euryale-v2.2', 'Euryale 3.1 70B v2.2', 91.9632, 91.9632, 28, 20000, 'Ролевая модель для выразительных диалогов и описания сцен.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261011_07', 'deepinfra:NousResearch/Hermes-3-Llama-3.1-405B', 'Hermes 3 405B', 108.192, 108.192, 32, 20000, 'Крупная модель для сложных сцен и нескольких персонажей.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261011_08', 'deepinfra:XiaomiMiMo/MiMo-V2.6-Flash', 'MiMo V2.6 Flash', 15.14688, 30.29376, 6, 20000, 'Новая модель MiMo для общения. Режим без рассуждений проходит проверку.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261011_09', 'deepinfra:deepseek-ai/DeepSeek-V3.2', 'DeepSeek V3.2', 28.12992, 41.11296, 10, 20000, 'Для сложных инструкций и продолжения истории.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261011_10', 'deepinfra:google/gemini-2.5-flash', 'Gemini 2.5 Flash', 32.4576, 270.48, 16, 20000, 'Для связных историй и работы с большим контекстом.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;

INSERT INTO "Model" ("id", "name", "displayName", "pricePer1MInput", "pricePer1MOutput", "priceVC", "maxContextTokens", "description", "isFreeForSubscribers", "isActive", "createdAt")
VALUES ('di_chat_20261011_11', 'deepinfra:NousResearch/Hermes-3-Llama-3.1-70B', 'Hermes 3 70B', 75.7344, 75.7344, 24, 20000, 'Ролевая модель для диалогов и совместного повествования.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "displayName"=EXCLUDED."displayName", "pricePer1MInput"=EXCLUDED."pricePer1MInput", "pricePer1MOutput"=EXCLUDED."pricePer1MOutput",
  "priceVC"=EXCLUDED."priceVC", "maxContextTokens"=EXCLUDED."maxContextTokens", "description"=EXCLUDED."description",
  "isFreeForSubscribers"=false, "isActive"=true;
