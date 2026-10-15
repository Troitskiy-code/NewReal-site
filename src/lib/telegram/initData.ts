import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Validation of Telegram Mini App launch data (WebApp.initData), as documented in
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// secret_key = HMAC_SHA256(key "WebAppData", bot_token), hash = HMAC_SHA256(secret_key, data_check_string).

export const INIT_DATA_MAX_LENGTH = 4096;
export const DEFAULT_INIT_DATA_MAX_AGE_SECONDS = 3600;
/** Allowed clock skew for auth_date in the future. */
const FUTURE_SKEW_SECONDS = 60;

export type TelegramLaunchUser = {
  /** Decimal string: Telegram ids exceed 2^31 and are kept out of floating point. */
  id: string;
  firstName: string;
  lastName: string | null;
  languageCode: string | null;
};

export type InitDataResult =
  | { ok: true; user: TelegramLaunchUser; authDate: number; startParam: string | null; replayKey: string }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "user" };

export function initDataSecretKey(botToken: string): Buffer {
  return createHmac("sha256", "WebAppData").update(botToken).digest();
}

export function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/** Builds signed initData; used by verification scripts and the browser emulation only. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  const hash = createHmac("sha256", initDataSecretKey(botToken)).update(dataCheckString(params)).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

function parseUser(raw: string | null): TelegramLaunchUser | null {
  if (!raw || raw.length > 2048) return null;
  let value: unknown;
  try {
    // Keep the id exact: rewrite the numeric id to a string before JSON.parse can round it.
    value = JSON.parse(raw.replace(/"id"\s*:\s*(\d{1,20})/, '"id":"$1"'));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const user = value as Record<string, unknown>;
  const id = typeof user.id === "string" ? user.id : null;
  if (!id || !/^[1-9]\d{0,19}$/.test(id) || user.is_bot === true) return null;
  const text = (input: unknown, max: number) =>
    typeof input === "string" ? input.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) || null : null;
  return {
    id,
    firstName: text(user.first_name, 64) ?? "",
    lastName: text(user.last_name, 64),
    languageCode: typeof user.language_code === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})?$/.test(user.language_code)
      ? user.language_code : null,
  };
}

/**
 * Strict check for issuing a session: signature, freshness of auth_date and the user field.
 * The caller additionally stores replayKey once (consumeInitDataReceipt) to refuse a replay.
 */
export function verifyInitData(
  initData: unknown,
  botToken: string,
  { maxAgeSeconds = DEFAULT_INIT_DATA_MAX_AGE_SECONDS, now = Date.now() }: { maxAgeSeconds?: number; now?: number } = {}
): InitDataResult {
  if (typeof initData !== "string" || !initData || initData.length > INIT_DATA_MAX_LENGTH || !botToken) {
    return { ok: false, reason: "malformed" };
  }
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const keys = [...params.keys()];
  // A repeated field would be ambiguous between our parser and the signature.
  if (new Set(keys).size !== keys.length) return { ok: false, reason: "malformed" };
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "malformed" };

  const expected = createHmac("sha256", initDataSecretKey(botToken)).update(dataCheckString(params)).digest();
  const provided = Buffer.from(hash, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return { ok: false, reason: "signature" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: "malformed" };
  const age = Math.floor(now / 1000) - authDate;
  if (age > maxAgeSeconds || age < -FUTURE_SKEW_SECONDS) return { ok: false, reason: "expired" };

  const user = parseUser(params.get("user"));
  if (!user) return { ok: false, reason: "user" };
  const startParam = params.get("start_param");
  return {
    ok: true,
    user,
    authDate,
    startParam: startParam && startParam.length <= 512 ? startParam : null,
    // The signature is unique per launch; only its digest is stored.
    replayKey: createHash("sha256").update(`tg-init:${hash}`).digest("hex"),
  };
}
