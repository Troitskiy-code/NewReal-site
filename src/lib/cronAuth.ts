import type { NextRequest } from "next/server";
import { infoLog } from "./logger";

export type CronSecretInspection = {
  configured: boolean;
  provided: boolean;
  matched: boolean;
};

export function getCronProvidedSecret(req: NextRequest): string {
  const querySecret = req.nextUrl.searchParams.get("secret");
  if (querySecret) return querySecret;
  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) return cronHeader;
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return "";
}

export function inspectCronSecrets(expected: string | undefined, provided: string): CronSecretInspection {
  const configured = typeof expected === "string" && expected.length > 0;
  return {
    configured,
    provided: provided.length > 0,
    matched: configured && provided === expected,
  };
}

export function logCronSecretCheck(prefix: string, expected: string | undefined, provided: string): CronSecretInspection {
  const inspection = inspectCronSecrets(expected, provided);
  infoLog(prefix, "secret check", inspection);
  return inspection;
}
