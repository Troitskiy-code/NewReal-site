/**
 * Проверка семантической дедупликации памяти, очистки Core и Episodic.
 * Запуск: node scripts/verify-memory-semantic.cjs
 */
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const axios = require("axios");
const { config } = require("dotenv");

config();

const SEMANTIC_DEDUP_THRESHOLD = Number.parseFloat(process.env.MEMORY_DEDUP_THRESHOLD || "0.80") || 0.8;
const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function cosineSimilarity(a, b) {
  if (!a.length || a.length !== b.length) return 0;
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

function keepUniqueByCosine(items, embeddings, threshold = SEMANTIC_DEDUP_THRESHOLD) {
  const result = [];
  const keptEmbeddings = [];
  for (let i = 0; i < items.length; i++) {
    const embedding = embeddings[i];
    if (!embedding) continue;
    const isDuplicate = keptEmbeddings.some((kept) => cosineSimilarity(embedding, kept) > threshold);
    if (!isDuplicate) {
      result.push(items[i]);
      keptEmbeddings.push(embedding);
    }
  }
  return result;
}

function unit(dim, index, jitter = 0) {
  const vector = Array.from({ length: dim }, () => 0);
  vector[index] = 1;
  vector[(index + 1) % dim] = jitter;
  return vector;
}

const NO_DATA_RE = /данных недостаточно/i;
const RELATIONSHIP_EVENT_RE =
  /ключевые изменения|предлож(?:ил|ила|или)\s+начать\s+встречаться|признал(?:ся|ась|ись)\s+в\s+чувствах|заключил(?:и|а)?\s+договор|узнал(?:а|и)?\s+тайну|принял(?:а|и)?\s+важное\s+решение/i;

function canonicalSectionName(title) {
  const stripped = title.replace(/\(.*?\)/g, "").trim();
  if (/^персонаж/i.test(stripped)) return "Персонаж";
  if (/^пользовател/i.test(stripped)) return "Пользователь";
  if (/^отношен/i.test(stripped)) return "Отношения";
  return stripped;
}

function sanitizeCoreMemory(raw) {
  const sections = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);

  const kept = [];
  for (const section of sections) {
    const name = canonicalSectionName(section.title);
    let lines = section.body
      .join("\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => {
        const stripped = line.replace(/^[-*•\d.)\s]+/, "").trim();
        return stripped && !NO_DATA_RE.test(stripped);
      });
    if (/^отношен/i.test(name)) {
      lines = lines.filter((line) => !RELATIONSHIP_EVENT_RE.test(line));
    }
    if (lines.length === 0) {
      console.info(`[Memory:Core] Skipped section "${name}" (no data)`);
      continue;
    }
    kept.push(`## ${name}\n${lines.join("\n")}`);
  }
  return kept.join("\n\n").trim();
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

const INITIATIVE = [
  "Рокс проверяет, готов ли Лукас взять инициативу.",
  "Рокс хочет понять, проявит ли Лукас решительность первым.",
  "Рокс испытывает Лукаса на смелость действовать самому.",
  "Рокс смотрит, хватит ли Лукасу духа сделать первый шаг.",
  "Рокс выжидает, начнёт ли Лукас действовать без подсказки.",
  "Рокс провоцирует Лукаса проявить самостоятельность.",
  "Рокс оценивает, способен ли Лукас вести сцену.",
];
const CLOSENESS = [
  "Лукас ищет способ сблизиться с Рокс.",
  "Лукас пытается сократить дистанцию между ними.",
  "Лукас хочет стать ближе к Рокс.",
  "Лукас прощупывает путь к большей близости.",
  "Лукас тянется к Рокс и ищет повод подойти.",
  "Лукас старается уменьшить холод между ними.",
];
const DISTRUST = [
  "Между ними растёт взаимное недоверие после сделки.",
  "После договора оба всё сильнее сомневаются друг в друге.",
  "Сделка оставила осадок подозрений у обоих.",
  "Они всё меньше верят друг другу из-за уговора.",
  "Недоверие копится с момента заключения сделки.",
  "Оба держат оборону, помня о договорённости.",
];
const LETTER = [
  "Тайна письма ещё не раскрыта и держит напряжение.",
  "Письмо остаётся загадкой и подогревает конфликт.",
  "Неизвестность отправителя письма не отпускает их.",
  "Секрет послания всё ещё висит между ними.",
  "Письмо не объяснено и продолжает давить.",
  "Они так и не выяснили, откуда взялось письмо.",
];
const PROMISE = [
  "Лукас обещал не уходить, пока не узнает правду.",
  "Лукас дал слово остаться до конца разговора.",
  "Лукас поклялся не исчезать, пока всё не прояснится.",
  "Лукас пообещал дождаться разгадки.",
  "Лукас обязался не бросать разговор на середине.",
  "Лукас заверил, что останется, пока не будет ответа.",
];
const CONFESSION = [
  "Рокс признался Лукасу в чувствах.",
  "Рокс открыто сказал, что влюблён в Лукаса.",
  "Рокс признал, что испытывает к Лукасу влечение.",
  "Рокс наконец открыл Лукасу свои чувства.",
  "Рокс сказал Лукасу, что тот ему небезразличен.",
  "Рокс признался, что хочет быть с Лукасом.",
];
const PACT = [
  "Они заключили договор не выдавать друг друга.",
  "Лукас и Рокс подписали уговор о молчании.",
  "Между ними появилось соглашение хранить секрет.",
  "Они договорились не сдавать друг друга властям.",
  "Заключён взаимный пакт о молчании.",
  "Оба поклялись не раскрывать общую тайну.",
];
const SECRET = [
  "Лукас узнал тайну происхождения Рокса.",
  "Лукасу открылось прошлое Рокса, которое тот скрывал.",
  "Лукас выяснил скрытую историю Рокса.",
  "Рокс раскрыл Лукасу свою настоящую личность.",
  "Лукас узнал, кем Рокс был раньше.",
  "Тайна прошлого Рокса стала известна Лукасу.",
];
const DECISION = [
  "Они приняли решение уехать вместе на рассвете.",
  "Лукас и Рокс решили сбежать вдвоём утром.",
  "Пара выбрала уехать, не дожидаясь суда.",
  "Они условились покинуть город вместе.",
  "Принято общее решение бежать до рассвета.",
  "Оба решили не оставаться в городе.",
];

const DIALOGUE_CLUSTERS = [
  INITIATIVE,
  CLOSENESS,
  DISTRUST,
  LETTER,
  PROMISE,
  CONFESSION,
  PACT,
  SECRET,
  DECISION,
];
const DIALOGUE_LINES = DIALOGUE_CLUSTERS.flat();

function wordDedup(lines) {
  const result = [];
  const significant = (line) =>
    line
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 4);
  for (const line of lines) {
    const words = significant(line);
    const isDuplicate = result.some((existing) => {
      const existingWords = significant(existing);
      const overlap = words.filter((word) => existingWords.includes(word)).length;
      return words.length > 0 && overlap / words.length > 0.6;
    });
    if (!isDuplicate) result.push(line);
  }
  return result;
}

console.log("Cosine similarity");
assert(cosineSimilarity([1, 0, 0, 0], [1, 0, 0, 0]) > 0.99, "identical vectors ~ 1");
assert(cosineSimilarity([1, 0, 0, 0], [0.97, 0.2, 0, 0]) > 0.85, "near-paraphrase vectors above threshold");
assert(cosineSimilarity([1, 0, 0, 0], [0, 1, 0, 0]) < 0.2, "orthogonal vectors stay low");
assert(SEMANTIC_DEDUP_THRESHOLD === 0.8, "threshold is 0.80");

console.log("\nSynthetic semantic dedup (50+ paraphrase lines)");
assert(DIALOGUE_LINES.length >= 50, `dialogue has ${DIALOGUE_LINES.length} lines`);

const dim = DIALOGUE_CLUSTERS.length;
const synthetic = DIALOGUE_CLUSTERS.flatMap((cluster, clusterIndex) =>
  cluster.map((_, itemIndex) => unit(dim, clusterIndex, itemIndex * 0.04))
);
const semanticKept = keepUniqueByCosine(DIALOGUE_LINES, synthetic, SEMANTIC_DEDUP_THRESHOLD);
assert(
  semanticKept.length === DIALOGUE_CLUSTERS.length,
  `semantic keeps ${DIALOGUE_CLUSTERS.length} unique lines (got ${semanticKept.length})`
);

const wordKept = wordDedup(DIALOGUE_LINES);
assert(
  wordKept.length > semanticKept.length,
  `word overlap keeps more synonyms (${wordKept.length} > ${semanticKept.length})`
);

console.log("\nCore sanitize");
const dirtyCore = `## Персонаж
- Стиль общения: (данных недостаточно)

## Пользователь
- Говорит прямо, любит вызов.

## Отношения
- Ключевые изменения за последнее время: пользователь предложил начать встречаться.
- Пользователь предложил начать встречаться.
`;
const cleaned = sanitizeCoreMemory(dirtyCore);
assert(!cleaned.includes("## Персонаж"), 'skips empty "Персонаж"');
assert(cleaned.includes("## Пользователь"), "keeps user facts");
assert(cleaned.includes("Говорит прямо"), "keeps user style");
assert(!cleaned.includes("## Отношения"), "skips event-only relationships");
assert(!cleaned.includes("предложил начать встречаться"), "strips relationship events");

const mixedRelations = `## Отношения (общее состояние)
- Тип: романтические, формирующиеся.
- Ключевые изменения за последнее время: признался в чувствах.
`;
const mixedCleaned = sanitizeCoreMemory(mixedRelations);
assert(mixedCleaned.includes("Тип: романтические"), "keeps relationship state");
assert(!mixedCleaned.includes("признался в чувствах"), "drops event lines from relationships");

const goodCharacter = `## Персонаж
- Ироничный, дерзкий, держит дистанцию.
- Стиль общения: короткие колкие реплики.
`;
assert(sanitizeCoreMemory(goodCharacter).includes("## Персонаж"), "keeps character section with real traits");

console.log("\nPrompt and lookback checks");
const advanced = readFileSync(resolve("src/lib/advancedMemory.ts"), "utf8");
const embeddingsSrc = readFileSync(resolve("src/lib/memoryEmbeddings.ts"), "utf8");
const chatMemory = readFileSync(resolve("src/lib/chatMemory.ts"), "utf8");
const sanitizeSrc = readFileSync(resolve("src/lib/coreMemorySanitize.ts"), "utf8");
assert(advanced.includes("take: 20"), "episodic lookback is 20");
assert(advanced.includes("Бросил деньги и повёл к выходу"), "classifier lists non-event examples");
assert(advanced.includes("Заказал напиток"), "classifier lists drink order as non-event");
assert(advanced.includes("только если есть ПОСЛЕДСТВИЯ"), "classifier requires consequences");
assert(advanced.includes("Ключевые изменения за последнее время: ..."), "core prompt forbids event dump");
assert(
  advanced.includes("Если раздел «Отношения» пуст или содержит только события"),
  "core skips event-only relations"
);
assert(advanced.includes("isEventAlreadyInSummary"), "still checks Memory.summary");
assert(advanced.includes("maxSimilarityAgainst"), "episodic uses embedding compare");
assert(embeddingsSrc.includes("openai/text-embedding-3-small"), "uses text-embedding-3-small");
assert(embeddingsSrc.includes("MEMORY_DEDUP_THRESHOLD"), "threshold is env-configurable");
assert(chatMemory.includes("logSimilarityMatrix"), "debug similarity matrix is wired");
assert(chatMemory.includes("deduplicateLinesSemantic"), "summary uses semantic line dedup");
assert(chatMemory.includes("consolidateActiveLines"), "summary consolidates leftover lines via LLM");
assert(chatMemory.includes("falling back to word overlap"), "summary falls back to word overlap");
assert(sanitizeSrc.includes('Skipped section "${name}" (no data)'), "core skip log is present");

const apiKey = (process.env.KODIKROUTER_API_KEY || "").trim();

async function maybeRunLiveEmbeddings() {
  if (!apiKey) {
    console.log("\nLive embeddings skipped (KODIKROUTER_API_KEY not set)");
    return;
  }

  console.log("\nLive embeddings (text-embedding-3-small)");
  const embeddings = await fetchEmbeddings(DIALOGUE_LINES, apiKey);
  const liveKept = keepUniqueByCosine(DIALOGUE_LINES, embeddings, SEMANTIC_DEDUP_THRESHOLD);
  console.log(
    `[Memory:Dedup] Semantic dedup: ${DIALOGUE_LINES.length} → ${liveKept.length} lines (similarity threshold ${SEMANTIC_DEDUP_THRESHOLD})`
  );
  assert(
    liveKept.length < DIALOGUE_LINES.length,
    `live semantic removed paraphrases (${DIALOGUE_LINES.length} → ${liveKept.length})`
  );
  assert(liveKept.length < wordKept.length, "live semantic drops more than word overlap");

  const eventEmb = await fetchEmbeddings([CONFESSION[0], CONFESSION[2]], apiKey);
  const eventSim = cosineSimilarity(eventEmb[0], eventEmb[1]);
  console.log(`[Episodic] Semantic dedup: event already exists (similarity ${eventSim.toFixed(2)})`);
  assert(eventSim > SEMANTIC_DEDUP_THRESHOLD, `confession paraphrases similar (${eventSim.toFixed(2)})`);
}

maybeRunLiveEmbeddings()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    console.log("PASS");
  })
  .catch((error) => {
    console.error("  ✗ live embeddings failed", error);
    process.exit(1);
  });
