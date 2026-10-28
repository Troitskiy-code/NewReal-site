import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const args = new Map(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/, "").split("="); return [key, value.join("=")]; }));
const code = args.get("locale"), label = args.get("label"), languageName = args.get("language-name");
if (!code || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(code) || Intl.getCanonicalLocales(code)[0] !== code || !label?.trim() || !languageName?.trim()) throw new Error("Usage: npm run i18n:add -- --locale=de --label=Deutsch --language-name=German --intl=de-DE");
const manifestPath = path.join(root, "public/locales/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const directory = path.join(root, "public/locales", code);
if (Object.hasOwn(manifest.locales, code) || existsSync(directory)) throw new Error(`Language already exists: ${code}`);
const intl = args.get("intl") || code, direction = args.get("direction") || "ltr";
Intl.getCanonicalLocales(intl);
if (!["ltr", "rtl"].includes(direction)) throw new Error("Direction must be ltr or rtl");
const dictionary = JSON.parse(readFileSync(path.join(root, "public/locales/en/common.json"), "utf8"));
function pluralForms(object) {
  const categories = new Intl.PluralRules(intl).resolvedOptions().pluralCategories;
  for (const [key, value] of Object.entries(object)) {
    if (value && typeof value === "object") pluralForms(value);
    const match = key.match(/^(.*)_(zero|one|two|few|many|other)$/);
    if (match && Object.hasOwn(object, `${match[1]}_other`)) {
      for (const category of categories) object[`${match[1]}_${category}`] ??= object[`${match[1]}_other`];
      if (!categories.includes(match[2])) delete object[key];
    }
  }
}
pluralForms(dictionary);
mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, "common.json"), JSON.stringify(dictionary, null, 2) + "\n");
manifest.locales[code] = { label, languageName, intl, direction, fallback: "en", enabled: false };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Created ${code} as a disabled draft using English source copy. Translate and review common.json, then enable it in manifest.json and run npm run i18n:sync.`);
