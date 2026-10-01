import { Logtail } from "@logtail/node";
import { redactSensitive } from "./redactSensitive";

function createLogtail(): Logtail | null {
  const token = process.env.LOGTAIL_SOURCE_TOKEN?.trim();
  const endpoint = process.env.LOGTAIL_INGESTING_HOST?.trim();
  if (!token || !endpoint) return null;

  return new Logtail(token, { endpoint });
}

const logtail = createLogtail();

function formatArg(value: unknown): string {
  const safe = redactSensitive(value);
  if (safe instanceof Error) {
    return safe.stack ?? safe.message;
  }
  if (typeof safe === "object" && safe !== null) {
    try {
      return JSON.stringify(safe);
    } catch {
      return String(safe);
    }
  }
  return String(safe);
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
  const safeArgs = args.map((arg) => redactSensitive(arg));
  const message = formatMessage(prefix, safeArgs);
  console.log(`[${prefix}]`, ...safeArgs);
  ship("debug", prefix, message);
}

export function infoLog(prefix: string, ...args: unknown[]) {
  const safeArgs = args.map((arg) => redactSensitive(arg));
  const message = formatMessage(prefix, safeArgs);
  console.info(`[${prefix}]`, ...safeArgs);
  ship("info", prefix, message);
}

export function errorLog(prefix: string, ...args: unknown[]) {
  const safeArgs = args.map((arg) => redactSensitive(arg));
  const message = formatMessage(prefix, safeArgs);
  console.error(`[${prefix}]`, ...safeArgs);
  ship("error", prefix, message);
}
