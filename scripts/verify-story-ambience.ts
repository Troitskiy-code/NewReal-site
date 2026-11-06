// node --import ./scripts/alias-register.mjs --test scripts/verify-story-ambience.ts
import { strictEqual } from "node:assert";
import { test } from "node:test";
import { storyAmbience, type StoryAmbience } from "@/lib/storyAmbience";

const city = "*Вы вышли на оживлённую улицу.*";
const rain = "*На улице идёт дождь, капли барабанят по зонту.*";
const forest = "*Вы углубились в лес.*";
const indoors = "*Она вошла в комнату. Дождь стучит по крыше.*";
const tavern = "На стол таверны лёг свежий лист с королевской печатью.";
const cases: ReadonlyArray<[string, StoryAmbience | null, string[]]> = [
  ["silence by default", null, []],
  ["an unknown scene does not get a generic loop", null, ["Она открыла глаза и улыбнулась."]],
  ["the Game of Thrones opening selects the tavern", "tavern", [tavern]],
  ["the tavern persists across conversation", "tavern", [tavern, "— Меня зовут Рейна."]],
  ["the tavern stops after leaving for the road", null, [tavern, "Вы вышли из таверны на дорогу."]],
  ["rain outside does not replace the tavern indoors", "tavern", [tavern, "Дождь стучит по крыше."]],
  ["leaving the tavern exposes the rain", "rain", [tavern, "Дождь стучит по крыше.", "Вы вышли из таверны."]],
  ["entering an ordinary room stops the tavern", null, [tavern, "Она вошла в комнату."]],
  ["English tavern entry", "tavern", ["You step into the tavern."]],
  ["street", "city", [city]],
  ["rain takes precedence outdoors", "rain", [city, rain]],
  ["brief mention of current outdoor weather", "rain", ["На улице дождь."]],
  ["past-tense narration still describes the current scene", "rain", [city, "Шёл холодный дождь."]],
  ["rain ends and reveals the street again", "city", [city, rain, "Дождь прекратился."]],
  ["rain persists between replies", "rain", [city, rain, "Она поправила шарф.", "Он кивнул."]],
  ["entering a room hides outdoor rain", null, [city, rain, indoors]],
  ["returning outdoors restores current weather", "rain", [city, rain, indoors, "Мы вышли наружу."]],
  ["the weather can change while indoors", null, [rain, indoors, "Дождь стих.", "Вы вышли наружу."]],
  ["latest location wins", "shore", [city, forest, "Вы вышли на берег. Волны набегают на песок."]],
  ["forest in the greeting", "forest", [forest, "— Добро пожаловать!"]],
  ["scene can open in the forest", "forest", ["Вы стоите в лесу. Темнеет."]],
  ["scene can open at the shore", "shore", ["Вы сидите на берегу."]],
  ["stairs are not a forest", "city", [city, "Вы вошли в лестничный пролёт."]],
  ["dialogue leaves the scene alone", "city", [city, "Лена: В лесу дождь идёт.", "— Мы вошли в дом."]],
  ["stage directions on dialogue lines count", "rain", [city, "— Привет! *Дождь начался.*"]],
  ["quoted speech leaves the scene alone", "city", [city, "Она сказала: «Дождь идёт»."]],
  ["reported speech leaves the scene alone", "city", [city, "Она сказала, что дождь идёт."]],
  ["the forecast is not a transition", "city", [city, "Завтра, если пойдёт дождь, вы зайдёте в дом."]],
  ["memories are not the current location", "city", [city, "Она вспомнила, как они вошли в лес."]],
  ["unselected choices do not change the scene", "city", [city, "Что дальше?\n1. Мы вышли на берег.\n2. Вы вошли в лес."]],
  ["quoted code does not change the scene", "city", [city, "Пример:\n```\nДождь идёт.\n```"]],
  ["last weather event wins in the same sentence", "city", [city, "Дождь начался, но дождь стих."]],
  ["negative rain cue", "city", [city, rain, "Уже не идёт дождь."]],
  ["English forest and rainfall", "rain", ["You walk into the forest.", "It is raining."]],
  ["English forest in the opening", "forest", ["You stand in a forest."]],
  ["English surf after the rain", "shore", ["Rain starts to fall.", "You walk onto the beach. The rain has stopped."]],
  ["English indoor shelter", null, ["The rain pours.", "You walked inside. Rain patters on the roof."]],
];

for (const [name, expected, replies] of cases) {
  test(name, () => strictEqual(storyAmbience(replies.map(content => ({ role: "assistant", content }))), expected));
}

test("a proposed action does not change the scene before the assistant confirms it", () => {
  strictEqual(storyAmbience([
    { role: "assistant", content: city },
    { role: "user", content: "Мы вошли в лес." },
  ]), "city");
});
