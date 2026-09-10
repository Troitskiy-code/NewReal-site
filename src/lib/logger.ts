import { Logtail } from "@logtail/node";

function resolveEndpoint(host: string | undefined): string {
  const fallback = "https://in.logtail.com";
  const raw = host?.trim() || fallback;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function createLogtail(): Logtail | null {
  const token = process.env.LOGTAIL_SOURCE_TOKEN?.trim();
  if (!token) return null;

  return new Logtail(token, {
    endpoint: resolveEndpoint(process.env.LOGTAIL_INGESTING_HOST),
  });
}

const logtail = createLogtail();

function isDebug(): boolean {
  return (process.env.LOG_LEVEL ?? "info").trim().toLowerCase() === "debug";
}

function formatArg(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatMessage(prefix: string, args: unknown[]): string {
  return `[${prefix}] ${args.map(formatArg).join(" ")}`;
}

function ship(level: "debug" | "info" | "error", prefix: string, message: string) {
  if (!logtail) return;

  const context = { prefix };
  const sent =
    level === "debug"
      ? logtail.debug(message, context)
      : level === "info"
        ? logtail.info(message, context)
        : logtail.error(message, context);

  void Promise.resolve(sent)
    .then(() => logtail.flush())
    .catch(() => undefined);
}

export function debugLog(prefix: string, ...args: unknown[]) {
  const message = formatMessage(prefix, args);
  if (isDebug()) {
    console.debug(`[DEBUG:${prefix}]`, ...args);
  }
  ship("debug", prefix, message);
}

export function infoLog(prefix: string, ...args: unknown[]) {
  const message = formatMessage(prefix, args);
  console.info(`[${prefix}]`, ...args);
  ship("info", prefix, message);
}

export function errorLog(prefix: string, ...args: unknown[]) {
  const message = formatMessage(prefix, args);
  console.error(`[${prefix}]`, ...args);
  ship("error", prefix, message);
}
