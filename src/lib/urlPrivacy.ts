/** Shared by the server response and browser analytics; never changes the checkout URL. */
export const PRIVATE_URL_HEADER = "x-nv-private-url";

const PAYMENT_KEYS = new Set([
  "payment", "invid", "invoiceid", "inv_id", "outsum", "out_sum",
  "signaturevalue", "signature", "crc", "receipt", "recurringid", "previousinvoiceid",
]);
const PAYMENT_DISPLAY_KEYS = new Set(["type", "plan", "culture"]);
const SECRET_KEYS = new Set([
  "token", "access_token", "refresh_token", "id_token", "password", "secret",
  "userid", "user_id", "email", "code", "state", "session", "sessionid",
]);

export function isPaymentQueryKey(key: string): boolean {
  const lower = key.toLowerCase();
  return PAYMENT_KEYS.has(lower) || PAYMENT_DISPLAY_KEYS.has(lower) || lower.startsWith("shp_");
}

export function hasPaymentReturnParams(params: URLSearchParams): boolean {
  return [...params.keys()].some((key) => PAYMENT_KEYS.has(key.toLowerCase()) || key.toLowerCase().startsWith("shp_"));
}

export function tokenPagePath(pathname: string): string | null {
  // Encoded separators must not hide a token route from analytics sanitization.
  let decoded = pathname;
  try { decoded = decodeURIComponent(pathname); } catch { /* retain malformed paths */ }
  const segments = decoded.split("/");
  const index = segments.findIndex((part) => /^(?:reset-password|verify-email)$/i.test(part));
  return index < 0 ? null : segments.slice(0, index + 1).join("/");
}

export function isPrivatePageUrl(url: URL): boolean {
  return Boolean(tokenPagePath(url.pathname)) || hasPaymentReturnParams(url.searchParams)
    || [...url.searchParams.keys()].some((key) => SECRET_KEYS.has(key.toLowerCase()));
}

/** Sanitize SDK payloads, including a URL nested in utm_referrer. Hashes are never sent. */
export function analyticsUrl(raw: string, base: string): string {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return new URL(base).origin + "/";
    url.username = "";
    url.password = "";
    url.hash = "";
    const tokenPath = tokenPagePath(url.pathname);
    if (tokenPath) {
      url.pathname = tokenPath;
      url.search = "";
      return url.href;
    }
    const paymentReturn = hasPaymentReturnParams(url.searchParams);
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (SECRET_KEYS.has(lower) || PAYMENT_KEYS.has(lower) || lower.startsWith("shp_")
        || (paymentReturn && PAYMENT_DISPLAY_KEYS.has(lower))) url.searchParams.delete(key);
      // SDK can interpret this as a referrer override. Keep attribution to the origin only.
      if (lower === "utm_referrer") {
        const value = url.searchParams.get(key);
        try {
          const ref = new URL(value ?? "");
          if (ref.protocol === "https:" || ref.protocol === "http:") url.searchParams.set(key, ref.origin + "/");
          else url.searchParams.delete(key);
        } catch { url.searchParams.delete(key); }
      }
    }
    return url.href;
  } catch {
    return new URL(base).origin + "/";
  }
}

export function analyticsReferrer(raw: string, base: string): string {
  return raw ? analyticsUrl(raw, base) : "";
}
