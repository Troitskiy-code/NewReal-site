/**
 * Прогон реальных активных линий через эмбеддинги на нескольких порогах.
 * Запуск: node scripts/probe-dedup-threshold.cjs
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

const THRESHOLDS = [0.85, 0.8, 0.78, 0.75];
const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function keepUniqueByCosine(items, embeddings, threshold) {
  const result = [];
  const keptEmbeddings = [];
  const dropped = [];
  for (let i = 0; i < items.length; i++) {
    const embedding = embeddings[i];
    let best = 0;
    let bestIndex = -1;
    for (let k = 0; k < keptEmbeddings.length; k++) {
      const score = cosineSimilarity(embedding, keptEmbeddings[k]);
      if (score > best) {
        best = score;
        bestIndex = k;
      }
    }
    if (best > threshold) {
      dropped.push({
        index: i,
        line: items[i],
        similarTo: result[bestIndex],
        similarity: best,
      });
    } else {
      result.push(items[i]);
      keptEmbeddings.push(embedding);
    }
  }
  return { result, dropped };
}

async function fetchEmbeddings(texts, apiKey) {
  const response = await axios.post(
    `${KODIKROUTER_URL}/embeddings`,
    { model: "openai/text-embedding-3-small", input: texts },
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
  );
  const rows = response.data?.data;
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new Error("Неполный ответ эмбеддингов");
  }
  return [...rows]
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map((row) => row.embedding);
}

function printMatrix(embeddings, threshold) {
  console.log(`[Memory:Dedup] Similarity matrix (threshold ${threshold}):`);
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const score = cosineSimilarity(embeddings[i], embeddings[j]);
      const mark = score > threshold ? " ← если > threshold, дедуплицируем" : "";
      console.log(`  [${i}-${j}]: ${score.toFixed(2)}${mark}`);
    }
  }
}

async function main() {
  const apiKey = (process.env.KODIKROUTER_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("KODIKROUTER_API_KEY не настроен");
  }

  const embeddings = await fetchEmbeddings(LINES, apiKey);
  printMatrix(embeddings, 0.8);

  const summary = [];
  for (const threshold of THRESHOLDS) {
    const { result, dropped } = keepUniqueByCosine(LINES, embeddings, threshold);
    summary.push({ threshold, kept: result.length, dropped: dropped.length, result, dropped });
    console.log(`\n=== threshold ${threshold.toFixed(2)}: ${LINES.length} → ${result.length} ===`);
    for (const line of result) console.log(`  KEEP  ${line}`);
    for (const item of dropped) {
      console.log(
        `  DROP  [${item.index}] ${item.line}\n        ~${item.similarity.toFixed(2)} «${item.similarTo}»`
      );
    }
  }

  console.log("\nCOUNTS");
  for (const row of summary) {
    console.log(`${row.threshold.toFixed(2)}: ${row.kept} kept, ${row.dropped.length} dropped`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
