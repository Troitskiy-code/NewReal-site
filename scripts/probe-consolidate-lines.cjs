/**
 * Прогон LLM-консолидации на 12 реальных активных линиях Рокс/Лукас.
 * Запуск: node scripts/probe-consolidate-lines.cjs
 */
const axios = require("axios");
const { config } = require("dotenv");

config();

const LINES = [
  "Лукас пытается понять, насколько Рокс действительно интересна ему.",
  "Рокс хочет выяснить, насколько Лукас готов открыться и проявить инициативу.",
  "Оба персонажа испытывают взаимное влечение, но продолжают играть в игру вызова.",
  "Рокс рассматривает Лукас как потенциальный объект интереса, но также как вызов.",
  "Персонаж ставит под сомнение намерения пользователя, намекая на возможность дальнейшего взаимодействия.",
  "Пользователь заинтересован в том, чтобы узнать больше о персонаже и её намерениях.",
  "Персонаж требует от пользователя продолжать игру.",
  "Персонаж ожидает от пользователя проявления интереса и дерзости.",
  "Персонаж демонстрирует уверенность и готовность к вызову.",
  "Персонаж открыто бросает вызов пользователю.",
  "Персонаж демонстрирует азарт и дерзость.",
  "Пользователь и персонаж продолжают испытывать друг друга.",
];

const CONSOLIDATION_PROMPT = `Ты — редактор ролевых диалогов. Тебе дан список активных сюжетных линий. Объедини близкие по смыслу в МАКСИМУМ 5.

ЖЁСТКИЕ ТРЕБОВАНИЯ:
- Каждая итоговая линия — МАКСИМУМ 15 слов.
- НЕ используй союзы «в то время как», «при этом», «рассматривая», «демонстрируя» для склейки. Это не консолидация, а соединение.
- Если две линии описывают одну суть — сформулируй ОДНУ ОБЩУЮ фразу.
- Убирай повторы слов: если «вызов» встречается в 3 линиях — оставь один раз.

ПРИМЕРЫ:

Плохо (склейка):
- «Лукас пытается понять, интересна ли Рокс, в то время как Рокс выясняет готовность Лукаса открыться»

Хорошо (обобщение):
- «Лукас и Рокс взаимно изучают друг друга»

Плохо (соединение):
- «Оба испытывают влечение и продолжают игру вызова, рассматривая друг друга как объекты интереса и вызов»

Хорошо (обобщение):
- «Рокс и Лукас флиртуют, играя в игру вызова»

Формат ответа — только список, без вступлений:
- Линия 1
- Линия 2
...

Входные линии:
{{lines}}`;

function parseConsolidatedItems(text, maxLines) {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, maxLines);
}

function countLineWords(line) {
  return line.trim().split(/\s+/).filter(Boolean).length;
}

async function main() {
  const apiKey = (process.env.KODIKROUTER_API_KEY || "").trim();
  if (!apiKey) throw new Error("KODIKROUTER_API_KEY не настроен");

  const userContent = CONSOLIDATION_PROMPT.replace(
    "{{lines}}",
    LINES.map((line) => `- ${line}`).join("\n")
  );

  const response = await axios.post(
    "https://api.kodikrouter.ru/v1/chat/completions",
    {
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "Ты — редактор." },
        { role: "user", content: userContent },
      ],
      max_tokens: 300,
      temperature: 0.3,
    },
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
  );

  const text = response.data?.choices?.[0]?.message?.content?.trim() || "";
  const result = parseConsolidatedItems(text, 5);
  const lengths = result.map(countLineWords);
  const avg = lengths.length
    ? Math.round(lengths.reduce((sum, n) => sum + n, 0) / lengths.length)
    : 0;

  console.log(`[Memory:Consolidate] ${LINES.length} → ${result.length} lines (avg length: ${avg} words)`);
  if (avg > 18) console.log("[Memory:Consolidate] WARNING: lines too long");
  console.log("--- raw ---");
  console.log(text);
  console.log("--- parsed ---");
  result.forEach((line, index) => {
    console.log(`- (${lengths[index]} слов) ${line}`);
  });

  let failed = false;
  if (result.length !== 5) {
    console.error(`FAIL: expected 5 lines, got ${result.length}`);
    failed = true;
  }
  for (const line of result) {
    const words = countLineWords(line);
    if (words > 15) {
      console.error(`FAIL: line too long (${words} words): ${line}`);
      failed = true;
    }
    if (/в то время как/i.test(line)) {
      console.error(`FAIL: glue phrase «в то время как»: ${line}`);
      failed = true;
    }
  }

  if (failed) process.exit(1);
  console.log("PASS");
}

main().catch((error) => {
  console.error("[Memory:Consolidate] Failed:", error);
  process.exit(1);
});
