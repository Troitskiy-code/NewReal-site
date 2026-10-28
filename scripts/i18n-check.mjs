import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "public/locales/manifest.json"), "utf8"));
function flatten(value, prefix = "", result = {}) {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object") flatten(item, name, result); else result[name] = item;
  }
  return result;
}
const dictionaries = Object.fromEntries(Object.keys(manifest.locales).filter(code => manifest.locales[code].enabled || process.argv.includes("--all")).map(code => [code, flatten(JSON.parse(readFileSync(path.join(root, `public/locales/${code}/common.json`), "utf8")))]));
const base = dictionaries[manifest.defaultLocale];
const placeholders = value => [...String(value).matchAll(/{{\s*([^{}]+?)\s*}}/g)].map(match => match[1]).sort().join(",");
let issues = 0;
for (const [code, dictionary] of Object.entries(dictionaries)) {
  // Russian few/many are not missing English translations. Require the target language's categories.
  const plural = /_(zero|one|two|few|many|other)$/;
  const expected = {};
  for (const [key, value] of Object.entries(base)) {
    if (!plural.test(key)) expected[key] = value;
    else for (const category of new Intl.PluralRules(manifest.locales[code].intl).resolvedOptions().pluralCategories) expected[key.replace(plural, `_${category}`)] = base[key.replace(plural, "_other")] ?? value;
  }
  const missing = Object.keys(expected).filter(key => !Object.hasOwn(dictionary, key));
  const extra = Object.keys(dictionary).filter(key => !Object.hasOwn(expected, key) && !plural.test(key));
  const invalid = Object.keys(expected).filter(key => Object.hasOwn(dictionary, key) && (typeof dictionary[key] !== typeof expected[key] || (typeof dictionary[key] === "string" && (!dictionary[key].trim() || placeholders(dictionary[key]) !== placeholders(expected[key])))));
  issues += missing.length + extra.length + invalid.length;
  console.log(`${code}: ${Object.keys(dictionary).length} entries; missing ${missing.length}, extra ${extra.length}, invalid ${invalid.length}`);
  for (const [label, keys] of [["missing", missing], ["extra", extra], ["invalid/placeholder mismatch", invalid]]) if (keys.length) console.error(`${code} ${label}: ${keys.join(", ")}`);
}
if (issues) process.exitCode = 1;
