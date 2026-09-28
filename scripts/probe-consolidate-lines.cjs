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

const CONSOLIDATION_PROMPT = `Ты — редактор ролевых диалогов. Тебе дан список активных сюжетных линий. Твоя задача — объединить близкие по смыслу линии так, чтобы осталось МАКСИМУМ {{max}}.

ПРАВИЛА:
- Если 2+ линии описывают одну суть с разных сторон — объедини в одну.
- Пример: «Рокс рассматривает Лукаса как объект интереса» + «Лукас пытается понять интерес Рокс» → «Рокс и Лукас взаимно изучают друг друга».
- НЕ объединяй разные линии, только похожие.
- Каждая итоговая линия — одно предложение в настоящем времени.
- Сохрани все важные смыслы.

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

async function main() {
  const apiKey = (process.env.KODIKROUTER_API_KEY || "").trim();
  if (!apiKey) throw new Error("KODIKROUTER_API_KEY не настроен");

  const userContent = CONSOLIDATION_PROMPT.replaceAll("{{max}}", "5").replace(
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
      max_tokens: 500,
      temperature: 0.3,
    },
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
  );

  const text = response.data?.choices?.[0]?.message?.content?.trim() || "";
  const result = parseConsolidatedItems(text, 5);
  const usage = response.data?.usage || {};
  const cost =
    ((usage.prompt_tokens || 600) * 0.15 + (usage.completion_tokens || 200) * 0.6) / 1_000_000;

  console.log(`[Memory:Consolidate] ${LINES.length} lines → ${result.length} (cost: ~$${cost.toFixed(4)})`);
  console.log("--- raw ---");
  console.log(text);
  console.log("--- parsed ---");
  for (const line of result) console.log(`- ${line}`);

  if (result.length === 0 || result.length > 5) {
    console.error(`FAIL: expected 1–5 lines, got ${result.length}`);
    process.exit(1);
  }
  console.log("PASS");
}

main().catch((error) => {
  console.error("[Memory:Consolidate] Failed:", error);
  process.exit(1);
});
