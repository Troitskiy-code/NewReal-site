import { prisma } from "@/lib/prisma";

let ensurePromise: Promise<void> | null = null;

async function runEnsure(): Promise<void> {
  await prisma.$queryRawUnsafe(`SELECT "lastSummarizedAt", "summarizedMessageCount" FROM "Memory" LIMIT 0`);
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
