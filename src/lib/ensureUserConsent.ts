import { prisma } from "@/lib/prisma";

let ensurePromise: Promise<void> | null = null;

async function runEnsure(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "acceptedTermsAt" TIMESTAMP(3)`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "acceptedPrivacyAt" TIMESTAMP(3)`
  );
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

export const REGISTER_CONSENT_COOKIE = "nv-register-consent";

export function isAcceptedFlag(value: unknown): boolean {
  return value === true || value === "true";
}
