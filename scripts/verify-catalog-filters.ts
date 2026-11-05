import assert from "node:assert/strict";
import { applyCatalogFiltersToParams, catalogFilterCount, computeCatalogFacets, EMPTY_CATALOG_FILTERS, parseCatalogFilters, toggleCatalogOption } from "../src/lib/catalogFilters.ts";
import { ALL_CHARACTER_TAGS, canonicalCharacterTag, parseTagsString, recommendationTags } from "../src/lib/characterTags.ts";
import { resolveArtStyle } from "../src/lib/onboarding.ts";
import { hasAdultText } from "../src/lib/characterSeoContent.ts";

const fromQuery = (query: string) => { const params = new URLSearchParams(query); return parseCatalogFilters((key) => params.get(key)); };

// URL round trip; unknown values are dropped.
const parsed = fromQuery("style=anime&gender=female&format=world&genre=romance,bogus,fantasy,romance&world=modern&trait=cold");
assert.deepEqual(parsed, { style: "anime", gender: "female", format: "world", genres: ["romance", "fantasy"], worlds: ["modern"], traits: ["cold"] });
assert.equal(catalogFilterCount(parsed), 7);
assert.deepEqual(fromQuery(applyCatalogFiltersToParams(new URLSearchParams("sort=top&genre=drama"), parsed).toString()), parsed);
assert.equal(applyCatalogFiltersToParams(new URLSearchParams("sort=top&genre=drama"), EMPTY_CATALOG_FILTERS).toString(), "sort=top");

// Single-choice groups switch, multi-choice groups add and remove.
const once = toggleCatalogOption(EMPTY_CATALOG_FILTERS, { group: "style", id: "anime" });
assert.equal(toggleCatalogOption(once, { group: "style", id: "realistic" }).style, "realistic");
assert.equal(toggleCatalogOption(once, { group: "style", id: "anime" }).style, null);
assert.deepEqual(toggleCatalogOption({ ...EMPTY_CATALOG_FILTERS, genres: ["drama"] }, { group: "genres", id: "drama" }).genres, []);

// Facets: what each option would leave, dead ends and removals.
const cards = [
  { tags: "Романтика, Фэнтези, Женский персонаж, Аниме" },
  { tags: "Романтика, Фэнтези, Женский персонаж", artStyle: "realistic" },
  { tags: "Романтика, Девушка" },
  { tags: "Экшен, Мужской персонаж", roleplayMode: "world" },
  { tags: null },
];
const facets = computeCatalogFacets(cards, fromQuery("genre=romance"));
assert.equal(facets.total, 3);
assert.equal(facets.options["genres:fantasy"], 2);
assert.equal(facets.options["genres:romance"], 3);
assert.equal(facets.options["genres:action"], 0);
assert.equal(facets.options["gender:female"], 3, "old spelling Девушка counts as a female card");
assert.equal(facets.options["format:world"], 0);
assert.equal(facets.options["format:character"], 3, "a card without a mode is one character");
assert.equal(facets.options["style:anime"], 1);
assert.equal(facets.without["genres:romance"], 5);

// Tag dictionary.
assert.equal(canonicalCharacterTag("Приключения"), "Приключение");
assert.equal(canonicalCharacterTag("Action"), "Экшен");
assert.equal(canonicalCharacterTag("Mystery"), "Мистика");
assert.equal(canonicalCharacterTag("Реалистичный"), "Реалистичный", "a drawing style is not a modern setting");
assert.ok(!ALL_CHARACTER_TAGS.includes("Ролевая игра"));
assert.deepEqual(recommendationTags("Ролевая игра, Драма"), ["Драма"]);
assert.deepEqual(parseTagsString("RPG, Drama"), ["Ролевая игра", "Драма"]);
assert.equal(resolveArtStyle(null, "Реалистичный, Драма"), "realistic");
assert.equal(resolveArtStyle("anime", "Реалистичный"), "anime");

// A denial is not adult content; the words themselves still are.
for (const text of ["Посвящена приключению и магии; без эротики.", "friendship and magic; without eroticism.", "Никакой эротики здесь нет"]) assert.equal(hasAdultText(text), false, text);
for (const text of ["очень сексуальное тело", "эротика", "18+", "very sexy body"]) assert.equal(hasAdultText(text), true, text);

console.log("catalog filters: ok");
