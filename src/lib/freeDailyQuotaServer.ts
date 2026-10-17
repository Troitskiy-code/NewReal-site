/** Off until FREE_DAILY_QUOTA_ENABLED=true, so the release and the switch-on are separate steps. */
export const isFreeDailyQuotaEnabled = () => ["1", "true"].includes((process.env['FREE_DAILY_QUOTA_ENABLED'] ?? "").trim().toLowerCase());
