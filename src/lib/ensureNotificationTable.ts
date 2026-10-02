import { prisma } from "@/lib/prisma";

let ensurePromise: Promise<void> | null = null;

async function runEnsure(): Promise<void> {
  await prisma.$queryRaw`SELECT "id", "userId", "read" FROM "Notification" LIMIT 0`;
}

export function ensureNotificationTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = runEnsure().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}
