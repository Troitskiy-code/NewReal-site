/**
 * Проверка правила Intent Analysis без вызова модели.
 * Запуск: node --experimental-strip-types scripts/verify-intent.ts
 */
import {
  applyIntentConfidenceGuard,
  classifyIntentByRules,
  type UserIntent,
} from "../src/lib/intentAnalyzer.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function expectRule(message: string, intent: UserIntent | null) {
  const result = classifyIntentByRules(message);
  const actual = result?.intent ?? null;
  assert(actual === intent, `"${message}" → ${intent ?? "model"} (got ${actual ?? "model"})`);
}

console.log("Intent rule pre-filter");

expectRule("Привет!", null);
expectRule("Я открываю дверь", null);
expectRule("Я атакую врага", null);
expectRule("Мы шли через лес, как вчера договаривались", null);
expectRule("Кто убил короля?", "fact");
expectRule("Где находится артефакт?", "fact");
expectRule("Когда началась война?", "fact");
expectRule("Сколько стражников у ворот?", "fact");
expectRule("Какой артефакт мы искали?", "fact");
expectRule("Почему он предал нас?", "fact");
expectRule("Who killed the king?", "fact");
expectRule("Как ты себя чувствуешь?", "general");
expectRule("Что ты думаешь об этом?", "general");
expectRule("How are you?", "general");
expectRule("Что происходит?", "question");
expectRule("Как пройти к замку?", "question");

console.log("Low-confidence guard");
{
  const high = applyIntentConfidenceGuard({ intent: "story", confidence: 0.81 }, "Мы бежим");
  assert(high.intent === "story" && high.source === "model", "confidence 0.81 keeps story");

  const low = applyIntentConfidenceGuard({ intent: "fact", confidence: 0.42 }, "Кто это?");
  assert(low.intent === "general" && low.source === "low-confidence", "confidence 0.42 falls back to general");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
