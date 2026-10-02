import { prisma } from "@/lib/prisma";

let ensurePromise: Promise<void> | null = null;

async function runEnsure(): Promise<void> {
  await prisma.$queryRawUnsafe(`SELECT "id", "token", "userId", "expiresAt" FROM "EmailVerificationToken" LIMIT 0`);
}

export function ensureEmailVerificationTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = runEnsure().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}
