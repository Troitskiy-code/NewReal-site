/**
 * One-shot admin script: fill missing Character *_en fields via Yandex Translate.
 * Run: node --experimental-strip-types scripts/translate-characters.ts
 *
 * Requires in .env:
 *   DATABASE_URL (or DIRECT_URL)
 *   YANDEX_API_KEY
 *   YANDEX_FOLDER_ID
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { translateCharacterFieldsToEn } from "../src/lib/translate.ts";

const SOURCE_FIELDS = [
  "name",
  "description",
  "appearance",
  "greeting",
  "scenario",
  "exampleDialogs",
  "avatarPrompt",
] as const;

const dbUrl = process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
if (!dbUrl) {
  console.error("Missing DATABASE_URL (or DIRECT_URL) in env. Aborting.");
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: { db: { url: dbUrl } },
});

type CharacterRow = {
  id: string;
  name: string;
  description: string | null;
  appearance: string | null;
  greeting: string | null;
  scenario: string | null;
  exampleDialogs: string | null;
  avatarPrompt: string | null;
  name_en: string | null;
  description_en: string | null;
  appearance_en: string | null;
  greeting_en: string | null;
  scenario_en: string | null;
  exampleDialogs_en: string | null;
  avatarPrompt_en: string | null;
};

function missingEnFields(character: CharacterRow): (typeof SOURCE_FIELDS)[number][] {
  const missing: (typeof SOURCE_FIELDS)[number][] = [];
  for (const source of SOURCE_FIELDS) {
    const value = character[source];
    const en = character[`${source}_en` as keyof CharacterRow];
    if (typeof value === "string" && value.trim() && !(typeof en === "string" && en.trim())) {
      missing.push(source);
    }
  }
  return missing;
}

async function main() {
  const apiKey = process.env.YANDEX_API_KEY?.trim();
  const folderId = process.env.YANDEX_FOLDER_ID?.trim();
  if (!apiKey || !folderId) {
    console.error("Missing YANDEX_API_KEY or YANDEX_FOLDER_ID in env. Aborting.");
    process.exit(1);
  }

  const characters = await prisma.character.findMany({
    select: {
      id: true,
      name: true,
      description: true,
      appearance: true,
      greeting: true,
      scenario: true,
      exampleDialogs: true,
      avatarPrompt: true,
      name_en: true,
      description_en: true,
      appearance_en: true,
      greeting_en: true,
      scenario_en: true,
      exampleDialogs_en: true,
      avatarPrompt_en: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const pending = characters.filter((c) => missingEnFields(c).length > 0);
  console.log(`Found ${characters.length} character(s); ${pending.length} need translation.`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const character of pending) {
    const label = `${character.id} (${character.name})`;
    try {
      const fields = missingEnFields(character);
      if (fields.length === 0) {
        skipped += 1;
        console.log(`[skip] ${label}`);
        continue;
      }

      const fieldsToTranslate: Partial<Record<(typeof SOURCE_FIELDS)[number], string | null>> = {};
      for (const source of fields) {
        fieldsToTranslate[source] = character[source];
      }

      const translations = await translateCharacterFieldsToEn(fieldsToTranslate);
      await prisma.character.update({
        where: { id: character.id },
        data: translations,
      });

      processed += 1;
      console.log(
        `[ok] ${processed}/${pending.length} ${label} — fields: ${Object.keys(translations).join(", ")}`
      );
    } catch (error) {
      errors += 1;
      console.error(`[error] ${label}`, error);
    }
  }

  const after = await prisma.character.findMany({
    select: {
      id: true,
      name: true,
      description: true,
      appearance: true,
      greeting: true,
      scenario: true,
      exampleDialogs: true,
      avatarPrompt: true,
      name_en: true,
      description_en: true,
      appearance_en: true,
      greeting_en: true,
      scenario_en: true,
      exampleDialogs_en: true,
      avatarPrompt_en: true,
    },
  });
  const stillMissing = after.filter((c) => missingEnFields(c).length > 0).length;

  console.log("\nDone.");
  console.log(`  processed: ${processed}`);
  console.log(`  skipped:   ${skipped}`);
  console.log(`  errors:    ${errors}`);
  console.log(`  still missing translations: ${stillMissing}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
