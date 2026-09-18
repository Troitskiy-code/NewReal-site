import { prisma } from "@/lib/prisma";

let ensurePromise: Promise<void> | null = null;

async function runEnsure(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Memory" ADD COLUMN IF NOT EXISTS "lastSummarizedAt" TIMESTAMP(3)`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Memory" ADD COLUMN IF NOT EXISTS "summarizedMessageCount" INTEGER NOT NULL DEFAULT 0`
  );
}

export function ensureMemoryHierarchyColumns(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = runEnsure().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}
