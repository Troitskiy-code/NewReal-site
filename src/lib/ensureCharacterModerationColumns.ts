import { prisma } from "@/lib/prisma";

let ensurePromise: Promise<void> | null = null;

async function runEnsure(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "moderationStatus" TEXT`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "moderationReason" TEXT`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "moderationWarnedAt" TIMESTAMP(3)`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "violationCount" INTEGER NOT NULL DEFAULT 0`
  );
}

export function ensureCharacterModerationColumns(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = runEnsure().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}
