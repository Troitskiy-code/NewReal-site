import { infoLog } from "./logger";
import { reportAuthFailure } from "./safeDiagnostics";

type ClientReason = "network" | "non_json" | "aborted" | "other";
const AUTH_PATHS = new Set(["session", "csrf", "providers", "signin", "signout", "callback", "_log"]);

/** Fixed classes of a browser fetch failure; the client-supplied text itself is never logged. */
function clientReason(message: unknown): ClientReason {
  const text = typeof message === "string" ? message : "";
  if (/failed to fetch|load failed|networkerror|network request failed|fetch failed/i.test(text)) return "network";
  if (/unexpected token|json|unexpected end of/i.test(text)) return "non_json";
  if (/abort/i.test(text)) return "aborted";
  return "other";
}

/** Only the NextAuth endpoint name survives; anything else in the reported URL is dropped. */
function clientPath(url: unknown): string {
  if (typeof url !== "string") return "unknown";
  const endpoint = /\/api\/auth\/([a-z_]+)/i.exec(url)?.[1]?.toLowerCase();
  return endpoint && AUTH_PATHS.has(endpoint) ? `/api/auth/${endpoint}` : "unknown";
}

/**
 * next-auth/react forwards browser-side failures (e.g. CLIENT_FETCH_ERROR when /api/auth/session cannot be
 * fetched: offline phone, backgrounded tab, a 502 HTML page during a deploy) to the public /api/auth/_log
 * endpoint with client=true. They are not server faults, and anyone can post them, so they must not land in
 * the error log. Server-side NextAuth errors keep their error-level report.
 */
export const nextAuthLogger = {
  error(code: string, metadata: unknown) {
    const record = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
    if (record.client === true || record.client === "true") {
      infoLog("NextAuthClient", /^[A-Z_]{1,40}$/.test(String(code)) ? String(code) : "UNKNOWN",
        { reason: clientReason(record.message), path: clientPath(record.url) });
      return;
    }
    reportAuthFailure(`NextAuth.${String(code)}`, metadata);
  },
  warn(code: string) {
    infoLog("NextAuth", String(code));
  },
  debug() {
    /* library debug disabled so provider errors cannot bypass redaction */
  },
};
