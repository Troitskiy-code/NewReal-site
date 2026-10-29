import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { moduleLoader } from "./lib/load-local-module.mjs";
const json = file => JSON.parse(readFileSync(file, "utf8"));
const manifest = json("public/locales/manifest.json");
const fixture = structuredClone(manifest);
fixture.locales.de = { label: "Deutsch", languageName: "German", intl: "de-DE", direction: "ltr", fallback: "en", enabled: true };
fixture.locales.ar = { label: "العربية", languageName: "Arabic", intl: "ar", direction: "rtl", fallback: "en", enabled: true };
fixture.locales.fr = { label: "Français", languageName: "French", intl: "fr-FR", direction: "ltr", fallback: "en", enabled: false };
const resources = Object.fromEntries(Object.keys(manifest.locales).filter(code => manifest.locales[code].enabled).map(code => [code, { common: json(`public/locales/${code}/common.json`) }]));
// Exercise the real structured copy for every enabled language, before the fallback fixtures.
const actualLoad = moduleLoader({ "src/lib/localeResources.generated.ts": { localeResources: structuredClone(resources) }, "@/components/LocaleLink": { __esModule: true, default: "a" } });
const actualLanding = actualLoad("src/lib/landingTexts.ts");
const actualGenres = actualLoad("src/lib/genreIntros.ts");
const ActualHomeAbout = actualLoad("src/components/HomeAbout.tsx").default;
for (const code of Object.keys(resources)) {
  for (const freeQuota of [true, false]) {
    const about = actualLanding.homeAbout(code, freeQuota);
    assert.ok(Array.isArray(about.paragraphs), `${code}: home paragraphs must be a list`);
    assert.ok(Array.isArray(about.faq), `${code}: home FAQ must be a list`);
    const html = renderToStaticMarkup(createElement(ActualHomeAbout, { locale: code, freeQuota }));
    assert.equal((html.match(/<details\b/g) || []).length, about.faq.length, `${code}: all home FAQ entries render on the server`);
  }
  const create = actualLanding.createLanding(code);
  for (const key of ["steps", "features", "faq"]) assert.ok(Array.isArray(create[key]), `${code}: creation ${key} must be a list`);
  assert.ok(Array.isArray(actualGenres.genreIntro("fantasy", code)), `${code}: genre introduction must be a list`);
}
resources.de = { common: { common: { cancel: "Abbrechen" }, landing: { home: { heading: "Deutsche Figuren" } } } };
resources.ar = { common: {} };
const load = moduleLoader({ "public/locales/manifest.json": fixture, "src/lib/localeResources.generated.ts": { localeResources: resources } });
const locales = load("src/lib/i18nConfig.ts");
const dict = load("src/lib/getDictionary.ts");
const character = load("src/lib/characterLocalization.ts");
const fields = load("src/lib/characterFields.ts");
const prompt = load("src/lib/chatSystemPrompt.ts");
const api = load("src/lib/apiI18n.ts");
const landing = load("src/lib/landingTexts.ts");
const genres = load("src/lib/genreIntros.ts");
assert.equal(locales.isLocale("de"), true);
assert.equal(locales.isLocale("fr"), false);
assert.equal(locales.isLocale("constructor"), false);
assert.equal(locales.resolveLocale("de-DE"), "de");
assert.equal(locales.negotiateLocale("fr-FR;q=1,de-DE;q=.9,en;q=.7"), "de");
assert.equal(locales.negotiateLocale("en;q=0,ru;q=.5"), "ru");
assert.equal(locales.negotiateLocale("en;q=invalid,de;q=.6"), "de");
assert.equal(locales.withLocale("/en/genres?q=1", "de"), "/de/genres?q=1");
assert.equal(locales.getLocaleFromPath("/de/character/hero"), "de");
assert.equal(locales.dateLocale("de"), "de-DE");
assert.equal(locales.localeDefinition("ar").direction, "rtl");
assert.deepEqual(locales.localeFallbacks("de"), ["de", "en", "ru"]);
assert.equal(dict.translate("de", "common.cancel"), "Abbrechen");
assert.equal(dict.translate("de", "structuredData.chatDescription", { name: "Ada" }), "Chat with Ada on NewVerse");
assert.equal(dict.translate("de", "structuredData.chatDescription", { name: "$&" }), "Chat with $& on NewVerse");
assert.equal(landing.homeAbout("de", true).heading, "Deutsche Figuren");
assert.ok(landing.homeAbout("de", false).faq[0].answer.includes("VerseCoins"));
assert.ok(landing.createLanding("de").steps[0].text.includes("8"));
assert.ok(genres.genreIntro("fantasy", "de").length);
const card = { name: "Герой", name_en: "Hero", descriptionCard: "Карточка", description_en: "English description", publicMemory: { content: "Память" }, translations: [{ locale: "de", name: "Held", greeting: "Hallo", publicMemory: "Erinnerung" }] };
assert.equal(character.localizedCharacterText(card, "name", "de"), "Held");
assert.equal(character.localizedCharacterText(card, "greeting", "de"), "Hallo");
assert.equal(character.localizedCharacterText(card, "publicMemory", "de"), "Erinnerung");
assert.equal(fields.getLocalizedCardDescription(card, "de"), "English description");
assert.equal(fields.getLocalizedCardDescription(card, "ru"), "Карточка");
assert.equal(character.localizedCharacterText({ name: "Исходное" }, "name", "ar"), "Исходное");
assert.ok(!("privateMemory" in character.publicTranslationSelect));
assert.ok(!("sourceHash" in character.publicTranslationSelect));
assert.ok(!("greeting" in character.publicTranslationSelect));
assert.ok(!("scenario" in character.publicTranslationSelect));
// A private chat shell must not serialize translated card text for an unauthenticated visitor.
let shellViewer = null;
const privateCard = { id: "private", name: "Личное", name_en: "Private", userId: "owner", isPublic: false, updatedAt: new Date(), translations: [{ locale: "de", name: "Privat" }] };
const pageLoad = moduleLoader({
  "next/navigation": { notFound: () => { throw new Error("SHELL_NOT_FOUND"); } },
  "src/lib/prisma.js": { prisma: { character: { findUnique: async ({ select }) => { assert.deepEqual(select.translations.select, { locale: true, name: true }); return privateCard; } } } },
  "src/lib/characterPublic.ts": { getViewerId: async () => shellViewer },
  "src/lib/characterCardImage.ts": { characterAvatarPath: () => "/avatar" },
  "src/lib/telegram/catalog.ts": { isCharacterAllowedInTelegram: async () => true },
  "src/app/chat/[id]/ChatPageClient.tsx": { default: () => null },
});
const chatPage = pageLoad("src/app/chat/[id]/page.tsx").default;
await assert.rejects(chatPage({ params: Promise.resolve({ id: "private" }) }), /SHELL_NOT_FOUND/);
shellViewer = "owner";
assert.equal((await chatPage({ params: Promise.resolve({ id: "private" }) })).props.initialShell.translations[0].name, "Privat");
const req = { headers: new Headers({ "x-locale": "de", "accept-language": "en" }), cookies: { get: () => ({ value: "ru" }) } };
assert.equal(api.getApiLocale(req), "de");
req.headers.delete("x-locale"); assert.equal(api.getApiLocale(req), "ru");
const german = prompt.assembleRoleplayPrompt({ name: "Held" }, "de").content;
assert.ok(german.includes("Always reply in German"));
assert.ok(!german.includes("Always reply in English"));
assert.ok(prompt.withTurnReminder([{ role: "user", content: "Hallo" }], "de")[0].content.includes("Write in German"));
assert.ok(prompt.assembleRoleplayPrompt({ name: "Герой" }, "ru").content.includes("Всегда отвечай на русском"));
const { default: i18n } = load("src/lib/i18n.ts");
await i18n.init();
const de = i18n.cloneInstance({ lng: "de", initAsync: false });
const ru = i18n.cloneInstance({ lng: "ru", initAsync: false });
assert.equal(de.t("common.cancel"), "Abbrechen");
// Translation generation is isolated from the real provider and excludes private source data.
const translatedInputs = [];
const serviceLoad = moduleLoader({ "src/lib/aiCostTelemetry.ts": { meteredPost: async () => { throw new Error("Unexpected provider request"); } } });
const service = serviceLoad("src/lib/characterTranslationService.ts");
const source = { name: "Герой", description: "Описание", publicMemory: { content: "Открытая память" }, privateMemory: { content: "PRIVATE DO NOT SEND" } };
const content = await service.translateCharacterContent(source, "de",{ask:async(stage,body)=>{
  translatedInputs.push(JSON.stringify(body));
  return stage==="draft"?{...service.characterTranslationSource(source),name:"Held",description:"Beschreibung",publicMemory:"Öffentliche Erinnerung"}:{patches:[]};
}});
assert.equal(content.name, "Held");
assert.equal(content.greeting, null);
assert.ok(!translatedInputs.join(" ").includes("PRIVATE"));
assert.equal(service.characterTranslationHash(source), service.characterTranslationHash({ ...source, privateMemory: "changed" }));
assert.notEqual(service.characterTranslationHash(source), service.characterTranslationHash({ ...source, name: "Другой" }));
assert.notEqual(service.characterTranslationHash({ ...source, name_en: "Old" }, "en"), service.characterTranslationHash({ ...source, name_en: "New" }, "en"));
await assert.rejects(service.translateCharacterContent(source,"de",{ask:async()=>{throw new Error("Synthetic provider failure");}}));
// Exercise the actual Prisma extension without a database or environment credentials.
let extension;
const savedGlobal = { prisma: globalThis.prisma, prismaBase: globalThis.prismaBase };
delete globalThis.prisma; delete globalThis.prismaBase;
try {
  const prismaLoad = moduleLoader({
    "@prisma/client": { PrismaClient: class { $extends(value) { extension = value; return {}; } } },
    "src/lib/requireEnv.ts": { getRequiredEnv: () => "postgresql://synthetic.invalid/test" },
    "src/lib/safeDiagnostics.ts": { reportPrismaFailure() {} },
  });
  prismaLoad("src/lib/prisma.js");
  const invoke = async data => {
    const args = { data };
    await extension.query.character.update({ args, query: async value => value });
    return args.data;
  };
  assert.deepEqual((await invoke({ name: "Новый" })).translations.deleteMany, {});
  assert.deepEqual((await invoke({ name_en: "New" })).translations.deleteMany, { locale: "en" });
  assert.equal((await invoke({ totalMessages: { increment: 1 } })).translations, undefined);
} finally {
  if (savedGlobal.prisma === undefined) delete globalThis.prisma; else globalThis.prisma = savedGlobal.prisma;
  if (savedGlobal.prismaBase === undefined) delete globalThis.prismaBase; else globalThis.prismaBase = savedGlobal.prismaBase;
}
assert.equal(de.t("structuredData.home"), "Home");
assert.equal(ru.t("common.cancel"), "Отмена");
assert.equal(de.t("common.cancel"), "Abbrechen");
// The real proxy handles a third locale without changing its route implementation.
const { NextRequest } = await import("next/server.js");
const { default: proxy } = load("src/proxy.js");
const rewritten = await proxy(new NextRequest("https://example.test/de/genres?sort=top"));
assert.equal(new URL(rewritten.headers.get("x-middleware-rewrite")).pathname, "/genres");
assert.equal(rewritten.headers.get("x-middleware-request-x-locale"), "de");
const redirected = await proxy(new NextRequest("https://example.test/genres", { headers: { "accept-language": "de-DE,en;q=.5" } }));
assert.equal(redirected.headers.get("location"), "https://example.test/de/genres");
assert.equal(redirected.cookies.get(locales.LOCALE_COOKIE)?.value, "de");
assert.equal(redirected.cookies.get(locales.LOCALE_AUTO_COOKIE)?.value, "1");
const automaticCookie = `${locales.LOCALE_COOKIE}=de; ${locales.LOCALE_AUTO_COOKIE}=1`;
const autoNextVisit = await proxy(new NextRequest("https://example.test/genres?q=story", { headers: { cookie: automaticCookie, "accept-language": "en" } }));
assert.equal(autoNextVisit.headers.get("location"), "https://example.test/en/genres?q=story");
assert.equal(autoNextVisit.cookies.get(locales.LOCALE_COOKIE)?.value, "en");
assert.equal(autoNextVisit.cookies.get(locales.LOCALE_AUTO_COOKIE)?.value, "1");
const autoExplicitLink = await proxy(new NextRequest("https://example.test/de/genres", { headers: { cookie: automaticCookie, "accept-language": "en" } }));
assert.equal(autoExplicitLink.headers.get("x-middleware-request-x-locale"), "de");
assert.equal(autoExplicitLink.cookies.get(locales.LOCALE_AUTO_COOKIE), undefined, "a localized URL must not overwrite the automatic preference");
assert.equal(autoExplicitLink.cookies.get(locales.LOCALE_COOKIE)?.value, "de");
assert.equal(api.getApiLocale(new NextRequest("https://example.test/api/characters", { headers: { cookie: `${locales.LOCALE_COOKIE}=de; ${locales.LOCALE_AUTO_COOKIE}=1`, "accept-language": "en" } })), "de", "API responses keep the explicit page language in automatic mode");
const manualChoice = await proxy(new NextRequest("https://example.test/genres", { headers: { cookie: `${locales.LOCALE_COOKIE}=de`, "accept-language": "en" } }));
assert.equal(manualChoice.headers.get("location"), "https://example.test/de/genres");
assert.equal(manualChoice.cookies.get(locales.LOCALE_COOKIE)?.value, "de");
const db = new PGlite();
try {
  await db.exec('CREATE TABLE "Character" ("id" TEXT PRIMARY KEY); INSERT INTO "Character" VALUES (\'hero\');');
  await db.exec(readFileSync("prisma/migrations/20261028120000_character_translations/migration.sql", "utf8"));
  await db.query('INSERT INTO "CharacterTranslation" ("characterId", "locale", "sourceHash", "name", "updatedAt") VALUES ($1,$2,$3,$4,NOW())', ["hero", "de", "hash", "Held"]);
  assert.equal((await db.query('SELECT "name" FROM "CharacterTranslation"')).rows[0].name, "Held");
  await assert.rejects(db.query('INSERT INTO "CharacterTranslation" ("characterId", "locale", "sourceHash", "updatedAt") VALUES ($1,$2,$3,NOW())', ["hero", "de", "hash"]));
  await db.exec('DELETE FROM "Character" WHERE "id"=\'hero\'');
  assert.equal((await db.query('SELECT * FROM "CharacterTranslation"')).rows.length, 0);
} finally { await db.close(); }
// Smoke-test the real authoring commands in a disposable project, leaving enabled languages unchanged.
const temporary = mkdtempSync(path.join(tmpdir(), "nv-i18n-"));
try {
  for (const directory of ["scripts", "src/lib", "public/locales/ru", "public/locales/en"]) mkdirSync(path.join(temporary, directory), { recursive: true });
  for (const file of ["scripts/i18n-add.mjs", "scripts/i18n-sync.mjs", "scripts/i18n-check.mjs", "public/locales/manifest.json", "public/locales/ru/common.json", "public/locales/en/common.json"]) copyFileSync(file, path.join(temporary, file));
  // The disposable authoring fixture starts with the base languages regardless of real additions.
  writeFileSync(path.join(temporary, "public/locales/manifest.json"), JSON.stringify({ defaultLocale: "ru", locales: { ru: manifest.locales.ru, en: manifest.locales.en } }));
  const run = (file, args = []) => spawnSync(process.execPath, [path.join(temporary, "scripts", file), ...args], { cwd: temporary, encoding: "utf8" });
  assert.equal(run("i18n-add.mjs", ["--locale=de", "--label=Deutsch", "--language-name=German", "--intl=de-DE"]).status, 0);
  assert.equal(run("i18n-add.mjs", ["--locale=ar", "--label=Arabic", "--language-name=Arabic", "--direction=rtl"]).status, 0);
  const manifestPath = path.join(temporary, "public/locales/manifest.json");
  const draft = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(draft.locales.de.enabled, false);
  assert.equal(draft.locales.ar.direction, "rtl");
  const checkedDrafts = run("i18n-check.mjs", ["--all"]);
  assert.equal(checkedDrafts.status, 0, checkedDrafts.stderr);
  draft.locales.de.enabled = true; writeFileSync(manifestPath, JSON.stringify(draft));
  assert.equal(run("i18n-sync.mjs").status, 0);
  assert.ok(readFileSync(path.join(temporary, "src/lib/localeResources.generated.ts"), "utf8").includes("locales/de/common.json"));
  assert.equal(run("i18n-sync.mjs", ["--check"]).status, 0);
  const file = path.join(temporary, "public/locales/de/common.json"), incomplete = JSON.parse(readFileSync(file, "utf8"));
  const brokenStructure = structuredClone(incomplete);
  brokenStructure.landing.home.faq = Object.assign({}, brokenStructure.landing.home.faq);
  writeFileSync(file, JSON.stringify(brokenStructure));
  const structureCheck = run("i18n-check.mjs");
  assert.equal(structureCheck.status, 1, "numeric-keyed FAQ objects must fail even when every leaf is present");
  assert.match(structureCheck.stderr, /invalid structure: landing\.home\.faq/);
  incomplete.structuredData.chatDescription = "Missing interpolation"; writeFileSync(file, JSON.stringify(incomplete));
  assert.equal(run("i18n-check.mjs").status, 1);
} finally {
  const resolved = path.resolve(temporary), parent = path.resolve(tmpdir()) + path.sep;
  if (!resolved.startsWith(parent) || !path.basename(resolved).startsWith("nv-i18n-")) throw new Error("Unexpected fixture cleanup path");
  rmSync(resolved, { recursive: true, force: true });
}
console.log("PASS multilingual routing, dictionaries, fallback, character content, API priority, prompts, SSR isolation and translation migration");
