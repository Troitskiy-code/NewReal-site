import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pageIndexingMetadata, PUBLIC_PAGE_PATHS } from "@/lib/seoIndexing";
import { FEATURED_GENRES } from "@/lib/characterTags";
import { GENRE_INTROS } from "@/lib/genreIntros";
import { catalogVariantText } from "@/lib/catalogMeta";
import { CREATE_LANDING, homeAbout } from "@/lib/landingTexts";
import {
  findFeaturedGenre, GENRE_INDEX_MIN_CHARACTERS, genreIndexingMetadata, indexableGenreIds, parseGenrePage,
} from "@/lib/genreSeo";

let checks = 0;
function check(condition: unknown, label: string) { assert.ok(condition, label); checks++; }
const origin = "https://newvers.ai";
for (const locale of ["ru", "en"] as const) {
  for (const [page, path] of Object.entries(PUBLIC_PAGE_PATHS)) {
    const metadata = pageIndexingMetadata(page, locale, origin);
    check(metadata.alternates?.canonical === `${origin}/${locale}${path === "/" ? "" : path}`, `${page}: canonical ${locale}`);
    check(metadata.alternates?.languages?.ru && metadata.alternates?.languages?.en, `${page}: both languages`);
    check((metadata.robots as { index: boolean }).index, `${page}: indexable`);
  }
}
for (const page of ["login", "register", "edit", "profile", "referral", "subscription", "notifications", "forgotPassword", "resetPassword", "verifyEmail"]) {
  const metadata = pageIndexingMetadata(page, "ru", origin);
  check((metadata.robots as { index: boolean }).index === false && !metadata.alternates, `${page}: noindex without homepage canonical`);
}
for (const page of ["home"]) {
  const base = pageIndexingMetadata(page, "ru", origin);
  const tracked = pageIndexingMetadata(page, "ru", origin, { etext: "ad", ybaip: "ad", utm_source: "direct", sort: "top", page: "1" });
  check(tracked.alternates?.canonical === base.alternates?.canonical, `${page}: advertising/default queries normalized`);
  for (const query of [{ page: "2" }, { sort: "new" }, { sort: "random" }, { q: "hero" }]) {
    const metadata = pageIndexingMetadata(page, "ru", origin, query);
    check(metadata.alternates?.canonical !== base.alternates?.canonical, `${page}: meaningful query preserved`);
    check((metadata.robots as { index: boolean }).index === false, `${page}: variant noindex`);
  }
}
const robots = readFileSync("src/app/robots.txt", "utf8");
check(/Clean-param: etext&ybaip&yclid&utm_source&utm_medium&utm_campaign&utm_content&utm_term&gclid&_openstat \/\s/.test(robots), "Clean-param present");
check(!/Clean-param:[^\n]*\b(?:sort|page|q|invoice|InvId)\b/.test(robots), "Clean-param keeps catalog, search and payment parameters");
check(!/^Disallow:.*(?:login|chat|_next|gallery)/m.test(robots), "crawlers can read noindex and render public content");

// Genre landing pages: canonical/hreflang per page number, one threshold for noindex and the sitemap.
check(GENRE_INDEX_MIN_CHARACTERS === 8, "genre threshold is 8 public characters");
const dictionaries = Object.fromEntries((["ru", "en"] as const).map((locale) =>
  [locale, JSON.parse(readFileSync(`public/locales/${locale}/common.json`, "utf8"))]));
for (const genre of FEATURED_GENRES) {
  check(findFeaturedGenre(genre.id) === genre, `${genre.id}: route id resolves`);
  for (const locale of ["ru", "en"] as const) {
    const first = genreIndexingMetadata(genre.id, locale, origin, { page: 1, publicCount: GENRE_INDEX_MIN_CHARACTERS });
    check(first.alternates?.canonical === `${origin}/${locale}/genres/${genre.id}`, `${genre.id}: canonical ${locale}`);
    check(first.alternates?.languages?.ru === `${origin}/ru/genres/${genre.id}` && first.alternates?.languages?.en === `${origin}/en/genres/${genre.id}`, `${genre.id}: hreflang ru/en`);
    check((first.robots as { index: boolean }).index, `${genre.id}: indexable at the threshold`);
    const second = genreIndexingMetadata(genre.id, locale, origin, { page: 2, publicCount: 30 });
    check(second.alternates?.canonical === `${origin}/${locale}/genres/${genre.id}?page=2`, `${genre.id}: page 2 canonical to itself`);
    check(second.alternates?.languages?.en === `${origin}/en/genres/${genre.id}?page=2`, `${genre.id}: page 2 hreflang keeps page`);
    const thin = genreIndexingMetadata(genre.id, locale, origin, { page: 1, publicCount: GENRE_INDEX_MIN_CHARACTERS - 1 });
    const thinRobots = thin.robots as { index: boolean; follow: boolean };
    check(thinRobots.index === false && thinRobots.follow === true, `${genre.id}: thin genre noindex,follow`);
    const text = dictionaries[locale].genrePage.items[genre.id];
    check(text?.h1 && text.description && text.description.length <= 160, `${genre.id}: ${locale} H1 and description <= 160`);
    const words = GENRE_INTROS[genre.id][locale].join(" ").split(/\s+/).filter((word) => /[\p{L}\d]/u.test(word)).length;
    check(words >= 100 && words <= 200, `${genre.id}: ${locale} intro is 100-200 words (${words})`);
  }
}
check(parseGenrePage(undefined) === 1 && parseGenrePage("1") === 1 && parseGenrePage("abc") === 1 && parseGenrePage("-3") === 1, "genre ?page= falls back to 1");
check(parseGenrePage("2") === 2 && parseGenrePage(["3", "4"]) === 3, "genre ?page= parsed");
// Public counts on prod, 2026-10-17: three thin genres stay out of the sitemap.
const prodCounts = { fantasy: 21, romance: 49, anime: 48, scifi: 5, mystic: 9, realistic: 55, adventure: 29, detective: 8, everyday: 49, cyberpunk: 8, horror: 5, comedy: 2, drama: 10 };
check(indexableGenreIds(prodCounts).join() === "fantasy,romance,anime,mystic,realistic,adventure,detective,everyday,cyberpunk,drama", "sitemap genres at prod counts");
check(indexableGenreIds({ ...prodCounts, comedy: GENRE_INDEX_MIN_CHARACTERS }).includes("comedy"), "a filled genre enters the sitemap without code changes");
check(indexableGenreIds({}).length === 0, "genres without counts stay out of the sitemap");

// Catalog variants are noindex but must not reuse the home title and description.
const translate = (locale: string, key: string, vars: Record<string, string | number> = {}) => {
  const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], dictionaries[locale as "ru" | "en"]);
  if (typeof value !== "string") throw new Error(`Missing ${locale} key ${key}`);
  return Object.entries(vars).reduce((text, [name, replacement]) => text.replaceAll(`{{${name}}}`, String(replacement)), value);
};
const homeText = { title: translate("ru", "meta.home.title"), description: translate("ru", "meta.home.description") };
const variant = (params: Record<string, string>, locale = "ru") => catalogVariantText((key, vars) => translate(locale, key, vars), params, homeText);
check(variant({}) === homeText && variant({ sort: "top" }) === homeText && variant({ page: "1" }) === homeText, "home and its canonical variants keep the home text");
check(variant({ utm_source: "x", yclid: "1" }) === homeText, "tracking parameters do not change the home text");
const variants = [variant({ page: "2" }), variant({ page: "3" }), variant({ sort: "new" }), variant({ sort: "random" }), variant({ sort: "for-you" }), variant({ q: "Аниме" }), variant({ sort: "new", page: "2" })];
check(new Set(variants.map(v => v.title)).size === variants.length && variants.every(v => v.title !== homeText.title), "catalog variant titles are unique");
check(new Set(variants.map(v => v.description)).size === variants.length && variants.every(v => v.description !== homeText.description), "catalog variant descriptions are unique");
check(variant({ page: "2" }).title.includes("страница 2") && variant({ q: "Аниме" }).title.includes("Аниме"), "page number and query appear in the title");
check(variant({ sort: "new" }, "en").title.startsWith("New AI characters"), "English variant titles are localized");
check(translate("ru", "meta.character.title", { name: "Сэм" }) !== translate("en", "meta.character.title", { name: "Сэм" }), "character title templates differ between RU and EN");
check(translate("ru", "meta.genre.descriptionPage", { description: "D", page: 2 }).includes("2"), "genre pages 2+ carry the page number in the description");

// Landing copy targets the main Wordstat clusters: "ИИ-персонажи / чат с ИИ-персонажами" and "создать ИИ-персонажа".
check(translate("ru", "meta.home.title").startsWith("ИИ-персонажи") && translate("ru", "meta.create.title").startsWith("Создать ИИ-персонажа"), "home and create titles lead with the target query");
for (const locale of ["ru", "en"] as const) {
  for (const page of ["home", "create"]) {
    check(translate(locale, `meta.${page}.description`).length <= 160, `${page}: ${locale} description <= 160`);
  }
  const wordCount = (texts: string[]) => texts.join(" ").split(/\s+/).filter((word) => /[\p{L}\d]/u.test(word)).length;
  for (const freeQuota of [true, false]) {
    const about = homeAbout(locale, freeQuota);
    const words = wordCount([...about.paragraphs, ...about.faq.flatMap((item) => [item.question, item.answer])]);
    check(words >= 250 && words <= 600 && about.faq.length >= 4, `home about: ${locale} ${words} words, ${about.faq.length} FAQ`);
  }
  const create = CREATE_LANDING[locale];
  const createWords = wordCount([create.intro, ...create.steps.flatMap((s) => [s.title, s.text]), ...create.features.flatMap((f) => [f.title, f.text]), ...create.faq.flatMap((f) => [f.question, f.answer])]);
  check(createWords >= 250 && createWords <= 800 && create.faq.length >= 4, `create landing: ${locale} ${createWords} words, ${create.faq.length} FAQ`);
}
check(homeAbout("ru", true).faq[0].answer !== homeAbout("ru", false).faq[0].answer, "free-reply answer follows FREE_DAILY_QUOTA_ENABLED");

if (process.argv.includes("--http")) {
  const result = spawnSync(process.execPath, ["scripts/verify-seo-runtime.mjs"], { stdio: "inherit", windowsHide: true });
  check(result.status === 0, "isolated SEO HTTP/DB/browser suite");
}
console.log(`SEO phase 1: ${checks} checks passed`);
