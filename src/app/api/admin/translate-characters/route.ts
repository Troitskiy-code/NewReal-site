import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  translateCharacterFieldsToEn,
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

const SOURCE_FIELDS: CharacterSourceField[] = [
  "name",
  "description",
  "appearance",
  "greeting",
  "scenario",
  "exampleDialogs",
  "avatarPrompt",
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

function missingSourceFields(character: CharacterWithTranslations): CharacterSourceField[] {
  const missing: CharacterSourceField[] = [];
  for (const source of SOURCE_FIELDS) {
    const value = character[source];
    const en = character[`${source}_en` as keyof CharacterWithTranslations];
    if (typeof value === "string" && value.trim() && !(typeof en === "string" && en.trim())) {
      missing.push(source);
    }
  }
  return missing;
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

export async function POST(req: NextRequest) {
  try {
    if (!isAuthorized(req)) {
      console.error("[Admin:TranslateAll] Unauthorized request");
      return NextResponse.json({ error: "Недостаточно прав" }, { status: 401 });
    }

    console.log("[Admin:TranslateAll] Starting mass character translation");

    const characters = (await prisma.character.findMany({
      select: CHARACTER_SELECT,
      orderBy: { createdAt: "asc" },
    })) as CharacterWithTranslations[];

    const pending = characters.filter(
      (character: CharacterWithTranslations) => missingSourceFields(character).length > 0
    );
    const skipped = characters.length - pending.length;

    console.log("[Admin:TranslateAll] Queue built", {
      total: characters.length,
      pending: pending.length,
      skipped,
      concurrency: CONCURRENCY,
    });

    let updated = 0;
    let errors = 0;
    const errorDetails: Array<{ id: string; name: string; error: string }> = [];

    await mapPool<CharacterWithTranslations, void>(
      pending,
      CONCURRENCY,
      async (character, index) => {
        const label = `${character.id} (${character.name})`;
        const fields = missingSourceFields(character);

        if (fields.length === 0) {
          console.log(`[Admin:TranslateAll] Skip (already complete): ${label}`);
          return;
        }

        try {
          const fieldsToTranslate: Partial<Record<CharacterSourceField, string | null>> = {};
          for (const source of fields) {
            fieldsToTranslate[source] = character[source];
          }

          console.log("[Admin:TranslateAll] Translating", {
            progress: `${index + 1}/${pending.length}`,
            id: character.id,
            name: character.name,
            fields,
          });

          const translations = await translateCharacterFieldsToEn(fieldsToTranslate);

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
