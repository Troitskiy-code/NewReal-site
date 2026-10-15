-- Full schema rollback of 20261014180000_telegram_miniapp. Last resort only: the normal rollback
-- is TELEGRAM_MINIAPP_ENABLED=0 with the tables kept. Dropping them loses Telegram links and
-- the Telegram catalog selection. Deploy code without the Telegram models first.
DROP TABLE IF EXISTS "TelegramCatalogEntry";
DROP TABLE IF EXISTS "TelegramInitDataReceipt";
DROP TABLE IF EXISTS "TelegramLinkToken";
DROP TABLE IF EXISTS "TelegramAccount";
