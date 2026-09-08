/**
 * Backfill Character.slug from names after the add_character_slug migration.
 * Run: node --experimental-strip-types scripts/backfill-character-slugs.ts
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { buildCharacterSlug } from "../src/lib/characterSlug.ts";

const dbUrl = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!dbUrl) {
  console.error("Missing DATABASE_URL (or DIRECT_URL) in env. Aborting.");
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: { db: { url: dbUrl } },
});

async function allocate(name: string, characterId: string, taken: Set<string>): Promise<string> {
  const preferred = buildCharacterSlug(name, characterId);
  if (!taken.has(preferred)) return preferred;
  for (let n = 2; n < 50; n += 1) {
    const candidate = buildCharacterSlug(name, characterId, String(n));
    if (!taken.has(candidate)) return candidate;
  }
  return `${preferred}-${Date.now().toString(36)}`;
}

async function main() {
  const characters = await prisma.character.findMany({
    select: { id: true, name: true, slug: true },
    orderBy: { createdAt: "asc" },
  });

  const taken = new Set(characters.map((character) => character.slug));
  let updated = 0;

  for (const character of characters) {
    taken.delete(character.slug);
    const slug = await allocate(character.name, character.id, taken);
    taken.add(slug);
    if (slug === character.slug) continue;
    await prisma.character.update({
      where: { id: character.id },
      data: { slug },
    });
    updated += 1;
    console.log(`[Character] slug ${character.id} -> ${slug}`);
  }

  console.log(`[Character] Backfilled ${updated} of ${characters.length} slugs`);
}

main()
  .catch((error) => {
    console.error("[Character] Slug backfill failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
