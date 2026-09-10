import { AsyncLocalStorage } from "node:async_hooks";
import { Logtail } from "@logtail/node";

const DEFAULT_LOGTAIL_USER_ID = "cmsoffxe60000j8scd75xiojf";
const USER_ID_IN_TEXT = /user=([a-z0-9]+)/i;
const logUserStore = new AsyncLocalStorage<string>();

function createLogtail(): Logtail | null {
  const token = process.env.LOGTAIL_SOURCE_TOKEN?.trim();
  const endpoint = process.env.LOGTAIL_INGESTING_HOST?.trim();
  if (!token || !endpoint) return null;

  return new Logtail(token, { endpoint });
}

const logtail = createLogtail();

function allowedLogtailUserId(): string {
  return (process.env.LOGTAIL_USER_ID ?? DEFAULT_LOGTAIL_USER_ID).trim();
}

function extractUserIdFromArgs(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    const match = arg.match(USER_ID_IN_TEXT);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function currentLogUserId(args: unknown[] = []): string | undefined {
  return logUserStore.getStore() ?? extractUserIdFromArgs(args);
}

function shouldShipToBetterStack(args: unknown[] = []): boolean {
  if (!logtail) return false;
  const allowed = allowedLogtailUserId();
  if (!allowed) return false;
  return currentLogUserId(args) === allowed;
}

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

function ship(level: "debug" | "info" | "error", prefix: string, message: string, userId?: string) {
  if (!logtail) return;

  const context = { prefix, ...(userId ? { userId } : {}) };
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

export function runWithLogUser<T>(userId: string, fn: () => T): T {
  return logUserStore.run(userId, fn);
}

export function getLogUserId(): string | undefined {
  return logUserStore.getStore();
}

export function debugLog(prefix: string, ...args: unknown[]) {
  const message = formatMessage(prefix, args);
  if (shouldShipToBetterStack(args)) {
    if (isDebug()) {
      console.debug(`[DEBUG:${prefix}]`, ...args);
    }
    ship("debug", prefix, message, currentLogUserId(args));
    return;
  }

  console.log(`[${prefix}]`, ...args);
}

export function infoLog(prefix: string, ...args: unknown[]) {
  const message = formatMessage(prefix, args);
  console.info(`[${prefix}]`, ...args);
  if (shouldShipToBetterStack(args)) {
    ship("info", prefix, message, currentLogUserId(args));
  }
}

export function errorLog(prefix: string, ...args: unknown[]) {
  const message = formatMessage(prefix, args);
  console.error(`[${prefix}]`, ...args);
  if (shouldShipToBetterStack(args)) {
    ship("error", prefix, message, currentLogUserId(args));
  }
}
