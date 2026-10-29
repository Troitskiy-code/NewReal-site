/** Dry run by default. Paid requests and writes require --apply. Never translates private memory. */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { translateCharacterContent } from "../src/lib/characterTranslationService.ts";
import { characterTranslationHash, characterTranslationSourceSelect } from "../src/lib/characterTranslationData.ts";
import { TRANSLATION_POLICY_HASH } from "../src/lib/characterTranslationPipeline.ts";

const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...value] = arg.replace(/^--/, "").split("="); return [key, value.join("=") || "true"]; }));
for (const flag of ["apply", "force"]) if (args.has(flag) && !["true", "false"].includes(args.get(flag)!)) throw new Error(`--${flag} must be true or false`);
const apply = args.get("apply") === "true", force = args.get("force") === "true";
const manifest = JSON.parse(readFileSync(new URL("../public/locales/manifest.json", import.meta.url), "utf8"));
const locale = args.get("locale");
if (!locale || !Object.hasOwn(manifest.locales, locale)) throw new Error("Specify a configured language: --locale=de");
const limit = Number(args.get("limit") ?? 50);
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("--limit must be between 1 and 1000");
const prisma = new PrismaClient();
let translated = 0, stale = 0, pending = 0, failed = 0;
try {
  // Cursor pagination prevents completed rows from consuming the work limit on a resumed run.
  let cursor: string | undefined;
  while (pending < limit) {
    const rows = await prisma.character.findMany({
      where: { isPublic:true,...(args.has("id")?{id:args.get("id")}: {}) },
      select: { ...characterTranslationSourceSelect, translations: { where: { locale }, select: { locale: true, sourceHash: true,pipelineHash:true } } },
      orderBy: { id: "asc" }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      const sourceHash = characterTranslationHash(row);
      if (!force && row.translations[0]?.sourceHash === sourceHash && [TRANSLATION_POLICY_HASH,"manual"].includes(row.translations[0].pipelineHash||"")) continue;
      pending++;
      if (!apply) { console.log(`Pending: ${row.id} -> ${locale}`); }
      else {
        try {
          const content = await translateCharacterContent(row, locale);
          const saved = await prisma.$transaction(async (tx) => {
            // Lock only for the final save, never while waiting for the translation provider.
            await tx.$queryRaw`SELECT "id" FROM "Character" WHERE "id" = ${row.id} FOR UPDATE`;
            const current = await tx.character.findUnique({ where: { id: row.id }, select: characterTranslationSourceSelect });
            if (!current?.isPublic || characterTranslationHash(current) !== sourceHash) return false;
            await tx.characterTranslation.upsert({
              where: { characterId_locale: { characterId: row.id, locale } },
              create: { characterId: row.id, locale, sourceHash,pipelineHash:TRANSLATION_POLICY_HASH,qualityReviewedAt:new Date(), ...content },
              update: { sourceHash,pipelineHash:TRANSLATION_POLICY_HASH,qualityReviewedAt:new Date(), ...content },
            });
            return true;
          });
          if (saved) translated++; else stale++;
        } catch { failed++; console.error(`Translation failed for ${row.id}; no partial translation saved`); }
      }
      if (pending >= limit) break;
    }
    if (rows.length < 100) break;
  }
  console.log(JSON.stringify({ locale, dryRun: !apply, pending, translated, stale, failed }));
  if (failed) process.exitCode = 1;
} finally { await prisma.$disconnect(); }
