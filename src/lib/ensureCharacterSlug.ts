import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildCharacterSlug } from "@/lib/characterSlug";
import { ensureCharacterLocaleColumns } from "@/lib/ensureCharacterLocaleColumns";

let ensurePromise: Promise<void> | null = null;

export function isMissingSlugColumn(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2022" &&
    String(error.meta?.column ?? "").includes("slug")
  );
}

function isPlaceholderSlug(slug: string | null, id: string): boolean {
  return !slug || slug === `c-${id}`;
}

async function backfillMissingSlugs(): Promise<void> {
  const rows = await prisma.character.findMany({
    select: { id: true, name: true, slug: true },
  });
  const missing = rows.filter((row) => isPlaceholderSlug(row.slug, row.id));
  if (missing.length === 0) return;

  const taken = new Set(
    rows
      .filter((row) => !isPlaceholderSlug(row.slug, row.id))
      .map((row) => row.slug)
      .filter((value): value is string => Boolean(value))
  );

  for (const character of missing) {
    let slug = buildCharacterSlug(character.name, character.id);
    let n = 2;
    while (taken.has(slug)) {
      slug = buildCharacterSlug(character.name, character.id, String(n));
      n += 1;
    }
    taken.add(slug);
    await prisma.character.update({
      where: { id: character.id },
      data: { slug },
    });
  }

  console.log(`[Character] Backfilled ${missing.length} slugs`);
}

async function runEnsure(): Promise<void> {
  await prisma.$executeRawUnsafe(`ALTER TABLE "Character" ADD COLUMN IF NOT EXISTS "slug" TEXT`);
  await backfillMissingSlugs();
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "Character_slug_key" ON "Character"("slug")`
  );
  await ensureCharacterLocaleColumns();
  console.log("[Character] Slug column is ready");
}

export function ensureCharacterSlugColumn(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = runEnsure().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}
