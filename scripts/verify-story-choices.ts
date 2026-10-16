import assert from "node:assert/strict";
import { splitStoryChoices } from "../src/lib/storyChoices.ts";

// The "Голос Духов" reply from production: options, then two closing lines.
const reply = [
  "Рюкэн замолкает.",
  "",
  "---",
  "",
  "Что ты сделаешь дальше?",
  "",
  "1. Отправиться в Замок Совета — вступить в клан официально.",
  "2. Сначала — в Горы Куротани. Ты слышишь шёпот Рюкэна.",
  "3. **Отправиться в Торговый город** — набрать союзников.",
  "4. Найти старого мастера меча.",
  "",
  "Выбери свой путь, Огненный Наследник.",
  "Огонь ждёт своего хозяина.",
].join("\n");

const split = splitStoryChoices(reply);
assert.ok(split, "finds the list");
assert.equal(split.choices.length, 4);
assert.equal(split.choices[2], "Отправиться в Торговый город — набрать союзников.");
assert.ok(split.before.endsWith("Что ты сделаешь дальше?"));
assert.equal(split.after, "Выбери свой путь, Огненный Наследник.\nОгонь ждёт своего хозяина.");

assert.equal(splitStoryChoices("Просто ответ без вариантов."), null, "no list");
assert.equal(splitStoryChoices("1. Один вариант"), null, "a single item is not a choice");
assert.equal(splitStoryChoices("2. Первый\n3. Второй"), null, "must start at 1");
assert.equal(
  splitStoryChoices("1. А\n2. Б\nстрока\nстрока\nстрока\nстрока\nстрока"),
  null,
  "a list in the middle of a long reply is left as text",
);
assert.deepEqual(splitStoryChoices("1) Да\n\n2) Нет")?.choices, ["Да", "Нет"], "blank lines and ) numbering");

console.log("story choices: ok");
