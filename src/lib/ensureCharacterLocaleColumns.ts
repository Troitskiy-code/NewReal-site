import { prisma } from "@/lib/prisma";

let ensurePromise: Promise<void> | null = null;

async function runEnsure(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "descriptionCard_en" TEXT`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "publicMemory_en" JSONB`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "privateMemory_en" JSONB`
  );
}

export function ensureCharacterLocaleColumns(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = runEnsure().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}
