import { prisma } from "@/lib/prisma";

let ensurePromise: Promise<void> | null = null;

async function runEnsure(): Promise<void> {
  await prisma.$queryRawUnsafe(`SELECT "moderationStatus", "moderationReason", "moderationWarnedAt", "violationCount" FROM "Character" LIMIT 0`);
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
