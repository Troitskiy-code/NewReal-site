const HEADING_MAP = [
  { key: "permanent", test: /^#{1,3}\s*(постоянн|permanent)/i },
  { key: "activeLines", test: /^#{1,3}\s*(активн|active\s+lines?)/i },
  { key: "events", test: /^#{1,3}\s*(недавн|recent\s+events?|событи|events)/i },
  { key: "emotion", test: /^#{1,3}\s*(эмоциональн|emotional)/i },
];

function headingKey(line) {
  const trimmed = line.trim();
  for (const entry of HEADING_MAP) {
    if (entry.test.test(trimmed)) return entry.key;
  }
  return null;
}

function extractListItems(block) {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*•]/.test(line) || /^\d+[.)]/.test(line))
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean);
}

function parseSummarySections(text) {
  const sections = {};
  const buckets = { permanent: [], activeLines: [], events: [], emotion: [] };
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const key = headingKey(line);
    if (key) {
      current = key;
      continue;
    }
    if (current) buckets[current].push(line);
  }
  for (const key of Object.keys(buckets)) {
    const body = buckets[key].join("\n").trim();
    if (body) sections[key] = body;
  }
  return sections;
}

function rebuildSummary(sections) {
  const parts = [];
  if (sections.permanent?.trim()) parts.push(`## Постоянное\n${sections.permanent.trim()}`);
  if (sections.activeLines?.trim()) parts.push(`## Активные линии\n${sections.activeLines.trim()}`);
  if (sections.events?.trim()) parts.push(`## Недавние события\n${sections.events.trim()}`);
  if (sections.emotion?.trim()) parts.push(`## Эмоциональный фон\n${sections.emotion.trim()}`);
  return parts.join("\n\n").trim();
}

function deduplicateLines(lines) {
  const result = [];
  const significantWords = (line) => line.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
  for (const line of lines) {
    const words = significantWords(line);
    const isDuplicate = result.some((existing) => {
      const existingWords = significantWords(existing);
      const overlap = words.filter((w) => existingWords.includes(w)).length;
      return words.length > 0 && overlap / words.length > 0.6;
    });
    if (!isDuplicate) result.push(line);
  }
  return result;
}

function eventsLimitForTokens(maxTokens) {
  if (maxTokens < 600) return 4;
  if (maxTokens < 1000) return 6;
  return 8;
}

function postProcessSummary(rawSummary, maxTokens) {
  const sections = parseSummarySections(rawSummary);
  if (sections.activeLines) {
    const lines = extractListItems(sections.activeLines);
    const limited = deduplicateLines(lines).slice(0, 5);
    sections.activeLines = limited.length ? limited.map((l) => `- ${l}`).join("\n") : undefined;
  }
  if (sections.events) {
    const events = extractListItems(sections.events);
    const limit = eventsLimitForTokens(maxTokens);
    const limited = deduplicateLines(events).slice(-limit);
    sections.events = limited.length ? limited.map((e, i) => `${i + 1}. ${e}`).join("\n") : undefined;
  }
  return rebuildSummary(sections);
}

const active = [
  "Рокс проверяет Лукаса на готовность действовать.",
  "Рокс хочет понять, готов ли Лукас проявить инициативу.",
  "Рокс проверяет, проявит ли Лукас инициативу.",
  "Лукас пытается понять, чего хочет Рокс.",
  "Лукас ищет способ сблизиться с Рокс.",
  "Между ними растёт взаимное недоверие после сделки.",
  "Сделка с бароном остаётся незакрытой и давит на обоих.",
  "Тайна письма ещё не раскрыта и держит напряжение.",
  "Рокс скрывает письмо и не говорит, кто его отправил.",
  "Лукас обещал не уходить, пока не узнает правду.",
  "Лукас дал обещание остаться до конца разговора.",
  "В городе ищут человека, похожего на Лукаса.",
];

const events = [
  "Лукас узнал, что барон требует долг за старую сделку.",
  "Рокс признался, что письмо поддельное.",
  "Свидетель исчез после разговора в порту.",
  "Лукас нашёл ключ от заброшенного склада.",
  "Барон объявил охоту на единственного свидетеля.",
  "Рокс отдал Лукасу карту тайного хода.",
  "Они заключили договор не выдавать друг друга.",
  "Тайник в часовне оказался пуст.",
  "Лукас пообещал остаться до рассвета.",
  "Стража закрыла южные ворота города.",
  "Рокс спрятал кинжал в сапоге перед встречей.",
  "В камине нашли обгоревший герб барона.",
];
while (events.length < 33) {
  events.push(`Бытовое действие без последствий: улыбнулся и заказал напиток ${events.length + 1}.`);
}

const raw = `## Активные линии
${active.map((line) => `- ${line}`).join("\n")}

## Недавние события
${events.map((event, index) => `${index + 1}. ${event}`).join("\n")}

## Эмоциональный фон
Напряжённое и настороженное.`;

const out = postProcessSummary(raw, 800);
const parsed = parseSummarySections(out);
const lineCount = extractListItems(parsed.activeLines || "").length;
const eventCount = extractListItems(parsed.events || "").length;

console.log("active", lineCount);
console.log("events", eventCount);
console.log("---");
console.log(out);

if (lineCount !== 5) {
  console.error(`FAIL active lines: expected 5, got ${lineCount}`);
  process.exit(1);
}
if (eventCount !== 6) {
  console.error(`FAIL events: expected 6, got ${eventCount}`);
  process.exit(1);
}
console.log("PASS");
