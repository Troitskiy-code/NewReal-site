import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  translateText,
  type CharacterEnField,
  type CharacterSourceField,
} from "@/lib/translate";

export const maxDuration = 300;

const CHARACTER_SELECT = {
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
} satisfies Prisma.CharacterSelect;

type CharacterWithTranslations = Prisma.CharacterGetPayload<{
  select: typeof CHARACTER_SELECT;
}>;

const FIELD_PAIRS: Array<{
  source: CharacterSourceField;
  target: CharacterEnField;
  getSource: (c: CharacterWithTranslations) => string | null;
  getTarget: (c: CharacterWithTranslations) => string | null;
}> = [
  {
    source: "name",
    target: "name_en",
    getSource: (c) => c.name,
    getTarget: (c) => c.name_en,
  },
  {
    source: "description",
    target: "description_en",
    getSource: (c) => c.description,
    getTarget: (c) => c.description_en,
  },
  {
    source: "appearance",
    target: "appearance_en",
    getSource: (c) => c.appearance,
    getTarget: (c) => c.appearance_en,
  },
  {
    source: "greeting",
    target: "greeting_en",
    getSource: (c) => c.greeting,
    getTarget: (c) => c.greeting_en,
  },
  {
    source: "scenario",
    target: "scenario_en",
    getSource: (c) => c.scenario,
    getTarget: (c) => c.scenario_en,
  },
  {
    source: "exampleDialogs",
    target: "exampleDialogs_en",
    getSource: (c) => c.exampleDialogs,
    getTarget: (c) => c.exampleDialogs_en,
  },
  {
    source: "avatarPrompt",
    target: "avatarPrompt_en",
    getSource: (c) => c.avatarPrompt,
    getTarget: (c) => c.avatarPrompt_en,
  },
];

const CONCURRENCY = 5;

function isAuthorized(req: NextRequest): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return false;
  }

  const authHeader = req.headers.get("Authorization");
  return authHeader === `Bearer ${adminSecret}`;
}

function isBlank(value: string | null | undefined): boolean {
  return value == null || !String(value).trim();
}

/**
 * Fields that need EN translation:
 * - source (RU) is non-empty
 * - target (_en) is null / empty / whitespace
 * - or force=true (retranslate even if _en already set)
 * - or _en is an exact copy of source (failed translate fallback)
 */
function missingSourceFields(
  character: CharacterWithTranslations,
  force = false
): CharacterSourceField[] {
  return FIELD_PAIRS.filter(({ getSource, getTarget }) => {
    const sourceValue = getSource(character);
    const targetValue = getTarget(character);

    if (isBlank(sourceValue)) {
      return false;
    }

    if (force) {
      return true;
    }

    if (isBlank(targetValue)) {
      return true;
    }

    // Previous failed runs may have saved RU text into *_en
    return sourceValue!.trim() === targetValue!.trim();
  }).map(({ source }) => source);
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

async function translateMissingFields(
  character: CharacterWithTranslations,
  fields: CharacterSourceField[]
): Promise<Partial<Record<CharacterEnField, string>>> {
  const translations: Partial<Record<CharacterEnField, string>> = {};

  await Promise.all(
    fields.map(async (source) => {
      const pair = FIELD_PAIRS.find((f) => f.source === source);
      if (!pair) {
        return;
      }

      const value = pair.getSource(character);
      if (isBlank(value)) {
        return;
      }

      const translated = await translateText(value!, "en");
      // Only persist if translation actually differs or at least non-empty
      if (!isBlank(translated)) {
        translations[pair.target] = translated;
        console.log("[Admin:TranslateAll] Field translated", {
          id: character.id,
          source,
          target: pair.target,
          originalLength: value!.length,
          translatedLength: translated.length,
        });
      }
    })
  );

  return translations;
}

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorized(req)) {
      console.error("[Admin:TranslateAll] Unauthorized request");
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const force = body?.force === true;

    console.log("[Admin:TranslateAll] Starting mass character translation", { force });

    const characters = (await prisma.character.findMany({
      select: CHARACTER_SELECT,
      orderBy: { createdAt: "asc" },
    })) as CharacterWithTranslations[];

    const pending = characters.filter(
      (character) => missingSourceFields(character, force).length > 0
    );
    const skipped = characters.length - pending.length;

    const sample = characters.slice(0, 5).map((c) => ({
      id: c.id,
      name: c.name,
      name_en_blank: isBlank(c.name_en),
      description_en_blank: isBlank(c.description_en),
      greeting_en_blank: isBlank(c.greeting_en),
      missing: missingSourceFields(c, force),
    }));

    console.log("[Admin:TranslateAll] Queue built", {
      total: characters.length,
      pending: pending.length,
      skipped,
      force,
      concurrency: CONCURRENCY,
      sample,
    });

    let updated = 0;
    let errors = 0;
    const errorDetails: Array<{ id: string; name: string; error: string }> = [];

    await mapPool<CharacterWithTranslations, void>(
      pending,
      CONCURRENCY,
      async (character, index) => {
        const label = `${character.id} (${character.name})`;
        const fields = missingSourceFields(character, force);

        if (fields.length === 0) {
          console.log(`[Admin:TranslateAll] Skip (already complete): ${label}`);
          return;
        }

        try {
          console.log("[Admin:TranslateAll] Translating", {
            progress: `${index + 1}/${pending.length}`,
            id: character.id,
            name: character.name,
            fields,
          });

          const translations = await translateMissingFields(character, fields);

          if (Object.keys(translations).length === 0) {
            throw new Error("No fields were translated successfully");
          }

          await prisma.character.update({
            where: { id: character.id },
            data: translations,
          });

          updated += 1;
          console.log("[Admin:TranslateAll] Updated", {
            progress: `${updated + errors}/${pending.length}`,
            id: character.id,
            name: character.name,
            fields: Object.keys(translations),
          });
        } catch (error) {
          errors += 1;
          const message = error instanceof Error ? error.message : "Unknown error";
          errorDetails.push({ id: character.id, name: character.name, error: message });
          console.error("[Admin:TranslateAll] Error", {
            id: character.id,
            name: character.name,
            error: message,
          });
        }
      }
    );

    const result = {
      success: true,
      total: characters.length,
      pending: pending.length,
      skipped,
      updated,
      errors,
      force,
      errorDetails: errorDetails.slice(0, 50),
    };

    console.log("[Admin:TranslateAll] Done", result);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Admin:TranslateAll] Fatal", message, error);
    return NextResponse.json(
      { success: false, error: "Ошибка массового перевода", details: message },
      { status: 500 }
    );
  }
}
