import { prisma } from "@/lib/prisma";

let ensurePromise: Promise<void> | null = null;

async function runEnsure(): Promise<void> {
  await prisma.$queryRawUnsafe(`SELECT "acceptedTermsAt", "acceptedPrivacyAt" FROM "User" LIMIT 0`);
}

export function ensureUserConsentColumns(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = runEnsure().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

export function isAcceptedFlag(value: unknown): boolean {
  return value === true || value === "true";
}
