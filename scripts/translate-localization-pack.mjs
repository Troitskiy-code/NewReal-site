/** Translate an interface and an Adminer public-catalog export without database credentials. */
import dotenv from "dotenv";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { characterTranslationSource, characterTranslationHash } from "../src/lib/characterTranslationData.ts";
import { CHARACTER_TRANSLATION_FIELDS } from "../src/lib/characterLocalization.ts";
import { protectTranslation, restoreTranslation, splitTranslationText, translationKey, translationImportSql, adaptPluralForms } from "./lib/localization-pack.mjs";

dotenv.config({ quiet: true });
const options = new Map(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, "").split("="); return [key, value.join("=") || "true"]; }));
const locale = options.get("locale"), apply = options.get("apply") === "true";
const manifest = JSON.parse(readFileSync("public/locales/manifest.json", "utf8"));
if (!locale || !Object.hasOwn(manifest.locales, locale) || locale === "en" || locale === "ru") throw new Error("Specify a configured additional language with --locale=es");
const directory = path.resolve(options.get("workdir") || ".runtime/localization");
mkdirSync(directory, { recursive: true });
const cacheFile = path.join(directory, `${locale}-cache.json`);
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : { version: 1, values: {}, characters: 0, requests: 0 };
if (cache.version !== 1) throw new Error("Unsupported checkpoint format");
const sourceDictionary = JSON.parse(readFileSync("public/locales/en/common.json", "utf8"));
const targetDictionary = structuredClone(sourceDictionary);
const reviewedPath = `public/locales/${locale}/reviewed.json`;
const reviewedInterface = existsSync(reviewedPath) ? JSON.parse(readFileSync(reviewedPath, "utf8")) : {};
const catalog = options.has("catalog") ? JSON.parse(readFileSync(options.get("catalog"), "utf8")) : [];
const allowed = new Set(["id", "isPublic", ...CHARACTER_TRANSLATION_FIELDS]);
if (!Array.isArray(catalog) || catalog.some(row => row.isPublic !== true || !row.id || Object.keys(row).some(key => !allowed.has(key))) || new Set(catalog.map(row => row.id)).size !== catalog.length) throw new Error("The catalog must contain unique, explicitly public records and approved fields only");
const jobs = new Map();
function translation(text, sourceLanguage) {
  if (typeof text !== "string" || !text.trim()) return () => text;
  const pieces = splitTranslationText(text).map(piece => {
    const prefix = piece.match(/^\s*/)[0], suffix = piece.match(/\s*$/)[0], core = piece.trim();
    const protectedValue = protectTranslation(core);
    if (!core || !/\p{L}/u.test(protectedValue.text.replace(/<[^>]*>|__NV_KEEP_\d+__/g, ""))) return () => piece;
    const key = translationKey(core, locale, sourceLanguage || "auto");
    if (!Object.hasOwn(cache.values, key)) jobs.set(key, { key, sourceLanguage, ...protectedValue });
    return () => prefix + cache.values[key] + suffix;
  });
  return () => pieces.map(render => render()).join("");
}
const dictionaryLeaves = [];
function walk(source, target, parent = "") {
  for (const [key, value] of Object.entries(source)) {
    const qualified = parent ? `${parent}.${key}` : key;
    if (typeof value === "string") dictionaryLeaves.push({ target, key, render: Object.hasOwn(reviewedInterface, qualified) ? () => reviewedInterface[qualified] : translation(value, "en") });
    else if (value && typeof value === "object") walk(value, target[key], qualified);
  }
}
walk(sourceDictionary, targetDictionary);
const records = catalog.map(row => {
  const source = Object.fromEntries(CHARACTER_TRANSLATION_FIELDS.map(field => [field, row[field] ?? null]));
  const content = characterTranslationSource(row);
  return { row, source, values: Object.fromEntries(CHARACTER_TRANSLATION_FIELDS.map(field => [field, translation(content[field])])) };
});
const batches = [];
for (const source of ["en", undefined]) {
  let batch = [], size = 0;
  for (const job of jobs.values()) {
    if (job.sourceLanguage !== source) continue;
    const length = Array.from(job.text).length;
    if (length > 9500) throw new Error("An encoded text segment exceeds the provider limit");
    if (size + length > 9500 || batch.length >= 100) { batches.push(batch); batch = []; size = 0; }
    batch.push(job); size += length;
  }
  if (batch.length) batches.push(batch);
}
const additionalCharacters = [...jobs.values()].reduce((sum, job) => sum + Array.from(job.text).length, 0);
const rate = Number(process.env.YANDEX_TRANSLATE_COST_RUB_PER_MILLION_CHARS || 500.4);
const plan = { locale, publicCharacters: records.length, interfaceEntries: dictionaryLeaves.length, cachedSegments: Object.keys(cache.values).length, additionalSegments: jobs.size, requests: batches.length, additionalCharacters, estimatedAdditionalRub: Number((additionalCharacters * rate / 1e6).toFixed(2)) };
console.log(JSON.stringify({ dryRun: !apply, ...plan }));
if (!apply) process.exit(0);
const ceiling = Number(options.get("max-characters") || 1_000_000);
if (!Number.isFinite(ceiling) || ceiling < 0 || additionalCharacters > ceiling) throw new Error("Translation plan exceeds --max-characters; no requests sent");
const apiKey = process.env.YANDEX_API_KEY?.trim(), folderId = process.env.YANDEX_FOLDER_ID?.trim();
if (!apiKey || !folderId) throw new Error("YANDEX_API_KEY and YANDEX_FOLDER_ID are required");
const checkpoint = () => writeFileSync(cacheFile, JSON.stringify(cache));
for (let index = 0; index < batches.length; index++) {
  const batch = batches[index];
  const response = await fetch("https://translate.api.cloud.yandex.net/translate/v2/translate", {
    method: "POST", headers: { Authorization: `Api-Key ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ targetLanguageCode: locale, ...(batch[0].sourceLanguage ? { sourceLanguageCode: batch[0].sourceLanguage } : {}), format: "HTML", texts: batch.map(job => job.text), folderId }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Translation provider returned HTTP ${response.status}; completed batches remain checkpointed`); }
  const data = await response.json();
  if (!Array.isArray(data.translations) || data.translations.length !== batch.length) throw new Error("Translation provider returned an incomplete batch");
  let invalid = 0;
  for (let item = 0; item < batch.length; item++) {
    try {
      const text = data.translations[item].text;
      if (typeof text !== "string" || !text.trim()) throw new Error("Empty translation");
      cache.values[batch[item].key] = restoreTranslation(text, batch[item].tokens);
    } catch { invalid++; }
  }
  cache.characters += batch.reduce((sum, job) => sum + Array.from(job.text).length, 0);
  cache.requests++;
  checkpoint();
  if (invalid) throw new Error(`Provider changed protected tokens in ${invalid} segments; valid results were checkpointed`);
  console.log(`Completed batch ${index + 1}/${batches.length}; checkpoint segments=${Object.keys(cache.values).length}`);
}
for (const leaf of dictionaryLeaves) leaf.target[leaf.key] = leaf.render();
if (existsSync(reviewedPath)) {
  for (const [key, value] of Object.entries(reviewedInterface)) {
    const segments = key.split("."); let target = targetDictionary;
    for (const segment of segments.slice(0, -1)) {
      if (!target || typeof target !== "object" || !Object.hasOwn(target, segment)) throw new Error(`Unknown reviewed translation path: ${key}`);
      target = target[segment];
    }
    const leaf = segments.at(-1);
    if (!Object.hasOwn(target, leaf) || typeof value !== "string") throw new Error(`Invalid reviewed translation: ${key}`);
    target[leaf] = value;
  }
}
adaptPluralForms(targetDictionary, manifest.locales[locale].intl);
const translations = records.map(({ row, source, values }) => ({ characterId: row.id, locale, sourceHash: characterTranslationHash(row, locale), ...Object.fromEntries(Object.entries(values).map(([field, render]) => [field, render()])), source }));
if (options.has("review")) {
  const reviewed = JSON.parse(readFileSync(options.get("review"), "utf8"));
  for (const row of translations) {
    const review = reviewed[row.characterId];
    if (!review) continue;
    for (const field of CHARACTER_TRANSLATION_FIELDS) if (row[field]) {
      for (const [from, to] of Object.entries(review.replace || {})) {
        const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        row[field] = row[field].replace(new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, "gu"), () => to);
      }
    }
    if (typeof review.name === "string" && review.name.trim()) row.name = review.name;
  }
}
writeFileSync(`public/locales/${locale}/common.json`, JSON.stringify(targetDictionary, null, 2) + "\n");
writeFileSync(path.join(directory, `${locale}-translations.json`), JSON.stringify(translations));
if (translations.length) writeFileSync(path.join(directory, `import-${locale}.sql`), translationImportSql(translations, CHARACTER_TRANSLATION_FIELDS));
const receipt = { locale, publicCharacters: records.length, interfaceEntries: dictionaryLeaves.length, provider: "yandextranslate", providerCharacters: cache.characters, providerRequests: cache.requests, estimatedRub: Number((cache.characters * rate / 1e6).toFixed(2)), generatedAt: new Date().toISOString() };
writeFileSync(path.join(directory, `${locale}-receipt.json`), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ completed: true, ...receipt }));
