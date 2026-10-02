import { meteredPost } from "@/lib/aiCostTelemetry";
import { encoding_for_model } from "tiktoken";
import { prisma } from "@/lib/prisma";
import { getContextTokenLimit } from "@/lib/chatEconomy";
import { isSubscriptionActive } from "@/lib/verseChatEconomy";
import { recordSummaryMemoryEntry } from "@/lib/advancedMemory";
import { ensureMemoryHierarchyColumns } from "@/lib/ensureMemoryHierarchyColumns";
import { errorLog, infoLog } from "@/lib/logger";
import { sanitizeCoreMemory } from "@/lib/coreMemorySanitize";
import {
  fetchEmbeddings,
  keepUniqueByCosine,
  logSimilarityMatrix,
  SEMANTIC_DEDUP_THRESHOLD,
} from "@/lib/memoryEmbeddings";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const SUMMARY_MODEL = "openai/gpt-4o-mini";
const KEEP_RECENT_MESSAGES = 25;

export type SubscriptionType = "start" | "dialog" | "story" | "universe" | null | undefined;

export type SummaryConfig = {
  maxTokens: number;
  thresholdRatio: number;
  refreshMessageThreshold: number;
  refreshTokenThreshold: number;
};

export const SUMMARY_CONFIG: Record<string, SummaryConfig> = {
  start: {
    maxTokens: 200,
    thresholdRatio: 0.5,
    refreshMessageThreshold: 15,
    refreshTokenThreshold: 1500,
  },
  dialog: {
    maxTokens: 500,
    thresholdRatio: 0.5,
    refreshMessageThreshold: 20,
    refreshTokenThreshold: 2000,
  },
  story: {
    maxTokens: 800,
    thresholdRatio: 0.6,
    refreshMessageThreshold: 30,
    refreshTokenThreshold: 2500,
  },
  universe: {
    maxTokens: 1500,
    thresholdRatio: 0.7,
    refreshMessageThreshold: 40,
    refreshTokenThreshold: 3000,
  },
};

export function getSummaryConfig(subscriptionType: string | null | undefined): SummaryConfig {
  const normalized = subscriptionType === "history" ? "story" : subscriptionType;
  if (!normalized || normalized === "start") return SUMMARY_CONFIG.start;
  return SUMMARY_CONFIG[normalized] ?? SUMMARY_CONFIG.dialog;
}

function getSummaryConfigForUser(user: {
  subscriptionType?: string | null;
  subscriptionEnd?: Date | string | null;
}): { config: SummaryConfig; plan: string } {
  const end =
    user.subscriptionEnd instanceof Date
      ? user.subscriptionEnd
      : user.subscriptionEnd
        ? new Date(user.subscriptionEnd)
        : null;
  const active = isSubscriptionActive({
    subscriptionType: user.subscriptionType ?? null,
    subscriptionEnd: end,
  });
  const plan = active ? user.subscriptionType ?? "dialog" : "start";
  return { config: getSummaryConfig(plan), plan: plan === "history" ? "story" : plan || "start" };
}

const SUMMARY_PROMPT = `Ты — суммаризатор ролевых диалогов. Сделай структурированную выжимку пары пользователь+персонаж.

ВАЖНО: Ниже тебе будет передан блок "Ключевая память" (Core). Эти факты НЕ нужно повторять в выжимке. Твоя задача — только сюжет, хронология и активные линии.

Формат ответа (строго соблюдай):

## Активные линии
МАКСИМУМ 5 строк. Если получилось больше — объедини похожие. Не дублируй одну и ту же идею разными словами.
Список незакрытых сюжетных линий: обещания, тайны, проверки, конфликты, цели. Каждая — одно предложение в настоящем времени.
Пример плохого вывода (не делай так):
- Рокс проверяет Лукаса.
- Рокс хочет понять, готов ли Лукас.
- Лукас пытается понять Рокс.
Пример хорошего вывода:
- Рокс проверяет, проявит ли Лукас инициативу.

## Недавние события
МАКСИМУМ 6 строк. Только события с последствиями. Если событий больше — выбери 6 самых значимых, остальные отбрось.
СТРОГО В ХРОНОЛОГИЧЕСКОМ ПОРЯДКЕ (от раннего к позднему). Только те, что ИЗМЕНИЛИ состояние мира или отношения:
- узнал важное, дал обещание, заключил договор, нашёл/потерял предмет, совершил действие с последствиями.
ЗАПРЕЩЕНО включать:
- Бытовые действия в сцене (заказал напиток, выпил шот, улыбнулся, подошёл).
- Реакции и эмоции (смеётся, удивлён, раздражён).
- Описания физических действий без последствий (провёл пальцем, протянул руку).
- Факты о персонаже/пользователе (они в Core).

## Эмоциональный фон
Одно предложение: тёплое / напряжённое / игривое / романтичное / тревожное.

Требования:
- Максимум {{maxTokens}} токенов.
- Пустые разделы НЕ выводить.
- Без «в данном диалоге», «итак», «стоит отметить».
- НЕ дублируй факты из Core.`;

const CHAPTER_PROMPT = `Ты — суммаризатор части ролевого диалога. Сделай краткую выжимку СТРОГО В ХРОНОЛОГИЧЕСКОМ ПОРЯДКЕ.

Формат:

## События
2–5 значимых событий (только с последствиями). Одно предложение каждое.

## Активные линии
Если появились новые обещания, тайны или цели — добавь 1–3 строки.

НЕ включай факты о характере персонажа или пользователя (они в Core).
Максимум {{maxTokens}} токенов. Имена — точно как в диалоге.`;

const MERGE_PROMPT = `Ты — суммаризатор ролевых диалогов. Объедини старую выжимку и новую часть в одну структурированную выжимку.

ВАЖНО: блок "Ключевая память" (Core) ниже — справочный. Эти факты НЕ дублируй в выжимке. Только сюжет, хронология и активные линии.

Формат:

## Активные линии
МАКСИМУМ 5 строк. Если получилось больше — объедини похожие. Не дублируй одну и ту же идею разными словами.
Объединить старые и новые линии. Если линия ЗАКРЫТА (обещание выполнено, тайна раскрыта, проверка завершена) — УБРАТЬ её. Оставить только незакрытые.
Пример плохого вывода (не делай так):
- Рокс проверяет Лукаса.
- Рокс хочет понять, готов ли Лукас.
- Лукас пытается понять Рокс.
Пример хорошего вывода:
- Рокс проверяет, проявит ли Лукас инициативу.

## Недавние события
МАКСИМУМ 6 строк. Только события с последствиями. Если событий больше — выбери 6 самых значимых, остальные отбрось.
Взять последние {{eventsLimit}} значимых событий из старой выжимки + новые события. Старые события вытесняются новыми, если их больше {{eventsLimit}}. Хронология строго от раннего к позднему.
ЗАПРЕЩЕНО включать:
- Бытовые действия в сцене (заказал напиток, выпил шот, улыбнулся, подошёл).
- Реакции и эмоции (смеётся, удивлён, раздражён).
- Описания физических действий без последствий (провёл пальцем, протянул руку).
- Факты о персонаже/пользователе (они в Core).

## Эмоциональный фон

Требования:
- Максимум {{maxTokens}} токенов.
- Активные линии — только незакрытые.
- Не дублируй факты и не копируй Core.
- Без вступлений.`;

type DialogMessage = {
  role: string;
  content: string;
  createdAt?: Date | string;
};

function applyPromptVars(prompt: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
    prompt
  );
}

type SummarySections = {
  permanent?: string;
  activeLines?: string;
  events?: string;
  emotion?: string;
};

const HEADING_MAP: Array<{ key: keyof SummarySections; test: RegExp }> = [
  { key: "permanent", test: /^#{1,3}\s*(постоянн|permanent)/i },
  { key: "activeLines", test: /^#{1,3}\s*(активн|active\s+lines?)/i },
  { key: "events", test: /^#{1,3}\s*(недавн|recent\s+events?|событи|events)/i },
  { key: "emotion", test: /^#{1,3}\s*(эмоциональн|emotional)/i },
];

function headingKey(line: string): keyof SummarySections | null {
  const trimmed = line.trim();
  for (const entry of HEADING_MAP) {
    if (entry.test.test(trimmed)) return entry.key;
  }
  return null;
}

function extractListItems(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*•]/.test(line) || /^\d+[.)]/.test(line))
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean);
}

export function parseSummarySections(text: string): SummarySections {
  const sections: SummarySections = {};
  const lines = text.split(/\r?\n/);
  let current: keyof SummarySections | null = null;
  const buckets: Record<keyof SummarySections, string[]> = {
    permanent: [],
    activeLines: [],
    events: [],
    emotion: [],
  };

  for (const line of lines) {
    const key = headingKey(line);
    if (key) {
      current = key;
      continue;
    }
    if (current) {
      buckets[current].push(line);
    }
  }

  for (const key of Object.keys(buckets) as Array<keyof SummarySections>) {
    const body = buckets[key].join("\n").trim();
    if (body) sections[key] = body;
  }

  if (!sections.activeLines && !sections.events && !sections.permanent && !sections.emotion) {
    const items = extractListItems(text);
    if (items.length > 0) {
      sections.events = items.map((item, index) => `${index + 1}. ${item}`).join("\n");
    }
  }

  return sections;
}

export function rebuildSummary(sections: SummarySections): string {
  const parts: string[] = [];
  if (sections.permanent?.trim()) {
    parts.push(`## Постоянное\n${sections.permanent.trim()}`);
  }
  if (sections.activeLines?.trim()) {
    parts.push(`## Активные линии\n${sections.activeLines.trim()}`);
  }
  if (sections.events?.trim()) {
    parts.push(`## Недавние события\n${sections.events.trim()}`);
  }
  if (sections.emotion?.trim()) {
    parts.push(`## Эмоциональный фон\n${sections.emotion.trim()}`);
  }
  return parts.join("\n\n").trim();
}

export function deduplicateLines(lines: string[]): string[] {
  const result: string[] = [];
  const significantWords = (line: string) =>
    line
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 4);

  for (const line of lines) {
    const words = significantWords(line);
    const isDuplicate = result.some((existing) => {
      const existingWords = significantWords(existing);
      const overlap = words.filter((word) => existingWords.includes(word)).length;
      return words.length > 0 && overlap / words.length > 0.6;
    });
    if (!isDuplicate) result.push(line);
  }

  return result;
}

export async function deduplicateLinesSemantic(
  lines: string[],
  apiKey: string
): Promise<string[]> {
  if (lines.length < 2) return lines;

  try {
    const embeddings = await fetchEmbeddings(lines, apiKey);
    logSimilarityMatrix(embeddings, SEMANTIC_DEDUP_THRESHOLD);
    const result = keepUniqueByCosine(lines, embeddings, SEMANTIC_DEDUP_THRESHOLD);

    infoLog(
      "Memory:Dedup",
      `Semantic dedup: ${lines.length} → ${result.length} lines (similarity threshold ${SEMANTIC_DEDUP_THRESHOLD})`
    );
    return result;
  } catch {
    infoLog("Memory:Dedup", "Semantic embeddings unavailable, falling back to word overlap");
    return deduplicateLines(lines);
  }
}

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

function countLineWords(line: string): number {
  return line
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function averageLineWords(lines: string[]): number {
  if (lines.length === 0) return 0;
  const total = lines.reduce((sum, line) => sum + countLineWords(line), 0);
  return Math.round(total / lines.length);
}

function parseConsolidatedItems(text: string, maxLines: number): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, maxLines);
}

export async function consolidateActiveLines(
  lines: string[],
  apiKey: string,
  maxLines = 5
): Promise<string[]> {
  if (lines.length <= maxLines) return lines;

  try {
    const userContent = CONSOLIDATION_PROMPT.replace(
      "{{lines}}",
      lines.map((line) => `- ${line}`).join("\n")
    );

    const response = await meteredPost("summary",
      `${KODIKROUTER_URL}/chat/completions`,
      {
        model: SUMMARY_MODEL,
        messages: [
          { role: "system", content: "Ты — редактор." },
          { role: "user", content: userContent },
        ],
        max_tokens: 300,
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const text = response.data?.choices?.[0]?.message?.content?.trim() || "";
    const parsed = parseConsolidatedItems(text, maxLines);
    const result = parsed.length > 0 ? parsed : lines.slice(0, maxLines);
    const avgLength = averageLineWords(result);

    infoLog(
      "Memory:Consolidate",
      `${lines.length} → ${result.length} lines (avg length: ${avgLength} words)`
    );
    if (avgLength > 18) {
      infoLog("Memory:Consolidate", "WARNING: lines too long");
    }
    return result;
  } catch (error) {
    errorLog("Memory:Consolidate", "Failed:", error);
    return lines.slice(0, maxLines);
  }
}

function eventsLimitForTokens(maxTokens: number): number {
  if (maxTokens < 600) return 4;
  if (maxTokens < 1000) return 6;
  return 8;
}

export async function postProcessSummary(
  rawSummary: string,
  maxTokens: number,
  apiKey: string
): Promise<string> {
  const sections = parseSummarySections(rawSummary);

  if (sections.activeLines) {
    const lines = extractListItems(sections.activeLines);
    const before = lines.length;
    const deduped = await deduplicateLinesSemantic(lines, apiKey);
    const consolidated =
      deduped.length > 5 ? await consolidateActiveLines(deduped, apiKey, 5) : deduped;
    const limited = consolidated.slice(0, 5);
    infoLog(
      "Memory:PostProcess",
      `Active lines: ${before} → ${limited.length} (dedupe: ${before - deduped.length}, consolidate: ${deduped.length - limited.length})`
    );
    sections.activeLines = limited.length > 0 ? limited.map((line) => `- ${line}`).join("\n") : undefined;
  }

  if (sections.events) {
    const events = extractListItems(sections.events);
    const before = events.length;
    const dedupedEvents = await deduplicateLinesSemantic(events, apiKey);
    const limit = eventsLimitForTokens(maxTokens);
    const limited = dedupedEvents.slice(-limit);
    infoLog(
      "Memory:PostProcess",
      `Events: ${before} → ${limited.length} (dedupe: ${before - dedupedEvents.length}, limit: ${dedupedEvents.length - limited.length})`
    );
    sections.events =
      limited.length > 0 ? limited.map((event, index) => `${index + 1}. ${event}`).join("\n") : undefined;
  }

  return rebuildSummary(sections);
}

async function finalizeSummary(
  raw: string,
  maxTokens: number,
  apiKey: string,
  fallback?: string
): Promise<string> {
  const processed = await postProcessSummary(raw, maxTokens, apiKey);
  if (processed.length >= 50) return processed;

  const previous = fallback?.trim();
  if (previous) {
    const processedFallback = await postProcessSummary(previous, maxTokens, apiKey);
    if (processedFallback.length >= 50) return processedFallback;
    if (previous.length >= 50) return previous;
  }

  return processed || raw.trim();
}

function getRecentEventsLimit(arcTokens: number, maxTokens: number): number {
  if (maxTokens <= 0) return 8;
  const arcRatio = arcTokens / maxTokens;
  if (arcRatio > 0.8) return 3;
  if (arcRatio > 0.5) return 5;
  return 8;
}

function countActiveLines(summary: string): number {
  const match = summary.match(/##\s*Активные линии\s*([\s\S]*?)(?=\n##\s|$)/i);
  if (!match) return 0;
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter((line) => line.length > 0).length;
}

function countTokens(text: string): number {
  try {
    const enc = encoding_for_model("gpt-4");
    const tokens = enc.encode(text);
    enc.free();
    return tokens.length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function formatDialogForSummary(messages: DialogMessage[]): string {
  return messages
    .map((message) => {
      const speaker = message.role === "user" ? "Пользователь" : "Персонаж";
      const time = message.createdAt
        ? new Date(message.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
        : "";
      return `[${time}] ${speaker}: ${message.content}`;
    })
    .join("\n\n");
}

function getHistoryForSummary(messages: DialogMessage[]): DialogMessage[] {
  if (messages.length <= KEEP_RECENT_MESSAGES) {
    return [];
  }

  return messages.slice(0, messages.length - KEEP_RECENT_MESSAGES);
}

function formatCoreContext(core: string | null | undefined): string {
  const text = core?.trim();
  if (!text) return "";
  return `\n\n=== Ключевая память (НЕ дублируй в выжимке) ===\n${text}`;
}

async function loadCoreMemoryText(userId: string, characterId: string): Promise<string | null> {
  const row = await prisma.coreMemory.findUnique({
    where: { userId_characterId: { userId, characterId } },
    select: { content: true },
  });
  if (!row?.content?.trim()) return null;
  return sanitizeCoreMemory(row.content, { log: false }) || null;
}

function lastSummarizedTimestamp(messages: DialogMessage[]): Date {
  const last = messages[messages.length - 1];
  if (!last?.createdAt) return new Date();
  return last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt);
}

async function requestKodikText(
  apiKey: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
  extraVars: Record<string, string | number> = {}
): Promise<string> {
  const response = await meteredPost("summary",
    `${KODIKROUTER_URL}/chat/completions`,
    {
      model: SUMMARY_MODEL,
      messages: [
        {
          role: "system",
          content: applyPromptVars(systemPrompt, { maxTokens, ...extraVars }),
        },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
      temperature: 0.4,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const text = response.data.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("Пустая суммаризация от ИИ");
  }

  return text;
}

async function requestSummary(
  apiKey: string,
  dialogText: string,
  maxTokens: number,
  coreText: string | null
): Promise<string> {
  const result = await requestKodikText(
    apiKey,
    SUMMARY_PROMPT,
    `${dialogText}${formatCoreContext(coreText)}`,
    maxTokens
  );
  return finalizeSummary(result, maxTokens, apiKey);
}

async function requestChapterSummary(
  apiKey: string,
  chapterText: string,
  maxTokens: number,
  coreText: string | null
): Promise<string> {
  const result = await requestKodikText(
    apiKey,
    CHAPTER_PROMPT,
    `${chapterText}${formatCoreContext(coreText)}`,
    maxTokens
  );
  return finalizeSummary(result, maxTokens, apiKey);
}

async function mergeSummaries(
  apiKey: string,
  oldSummary: string,
  newChapter: string,
  maxTokens: number,
  eventsLimit: number,
  coreText: string | null
): Promise<string> {
  infoLog("Memory", "Summary merge: skipped Core duplication check");
  const userContent = `## Старая выжимка:\n${oldSummary}\n\n## Новая часть:\n${newChapter}${formatCoreContext(coreText)}`;
  const result = await requestKodikText(apiKey, MERGE_PROMPT, userContent, maxTokens, { eventsLimit });
  return finalizeSummary(result, maxTokens, apiKey, oldSummary);
}

async function persistMemorySummary(
  userId: string,
  characterId: string,
  summary: string,
  lastSummarizedAt: Date,
  summarizedMessageCount: number
): Promise<string> {
  await prisma.memory.upsert({
    where: { userId_characterId: { userId, characterId } },
    create: {
      userId,
      characterId,
      summary,
      lastSummarizedAt,
      summarizedMessageCount,
    },
    update: {
      summary,
      lastSummarizedAt,
      summarizedMessageCount,
    },
  });
  await recordSummaryMemoryEntry(userId, characterId, summary);
  return summary;
}

async function createArcSummary(
  userId: string,
  characterId: string,
  apiKey: string,
  messagesToSummarize: DialogMessage[],
  config: SummaryConfig,
  plan: string
): Promise<string | null> {
  if (messagesToSummarize.length === 0) {
    return null;
  }

  const dialogText = formatDialogForSummary(messagesToSummarize);
  const tokens = countTokens(dialogText);
  const coreText = await loadCoreMemoryText(userId, characterId);
  const summary = await requestSummary(apiKey, dialogText, config.maxTokens, coreText);
  await persistMemorySummary(
    userId,
    characterId,
    summary,
    lastSummarizedTimestamp(messagesToSummarize),
    messagesToSummarize.length
  );
  infoLog(
    "Memory",
    `Created arc summary (${messagesToSummarize.length} messages, ${tokens} tokens, subscription: ${plan})`
  );
  infoLog(
    "Memory",
    `Summary generated (subscription: ${plan}, maxTokens: ${config.maxTokens}, messageCount: ${messagesToSummarize.length}, summaryTokens: ${countTokens(summary)})`
  );
  infoLog("Memory", `Active lines count: ${countActiveLines(summary)}`);
  return summary;
}

async function updateArcWithChapter(
  userId: string,
  characterId: string,
  apiKey: string,
  existingSummary: string,
  existingCount: number,
  chapterMessages: DialogMessage[],
  config: SummaryConfig,
  plan: string
): Promise<string> {
  const chapterText = formatDialogForSummary(chapterMessages);
  const chapterTokens = countTokens(chapterText);
  const arcTokens = countTokens(existingSummary);
  const arcRatio = config.maxTokens > 0 ? arcTokens / config.maxTokens : 0;
  const eventsLimit = getRecentEventsLimit(arcTokens, config.maxTokens);
  infoLog(
    "Memory",
    `Arc size: ${arcTokens} tokens (ratio: ${arcRatio.toFixed(2)}) → eventsLimit: ${eventsLimit}`
  );
  const coreText = await loadCoreMemoryText(userId, characterId);
  const chapterSummary = await requestChapterSummary(apiKey, chapterText, config.maxTokens, coreText);
  const mergedSummary = await mergeSummaries(
    apiKey,
    existingSummary,
    chapterSummary,
    config.maxTokens,
    eventsLimit,
    coreText
  );
  await persistMemorySummary(
    userId,
    characterId,
    mergedSummary,
    lastSummarizedTimestamp(chapterMessages),
    existingCount + chapterMessages.length
  );
  infoLog(
    "Memory",
    `Created chapter (${chapterMessages.length} messages, ${chapterTokens} tokens) → merged into arc`
  );
  infoLog(
    "Memory",
    `Summary generated (subscription: ${plan}, maxTokens: ${config.maxTokens}, messageCount: ${chapterMessages.length}, summaryTokens: ${countTokens(mergedSummary)})`
  );
  infoLog("Memory", `Active lines count: ${countActiveLines(mergedSummary)}`);
  return mergedSummary;
}

export async function resolveChatMemorySummary(
  userId: string,
  characterId: string,
  apiKey: string,
  user: {
    subscriptionType?: string | null;
    subscriptionEnd?: Date | string | null;
  }
): Promise<string | null> {
  await ensureMemoryHierarchyColumns();

  const { config, plan } = getSummaryConfigForUser(user);
  const maxContextTokens = getContextTokenLimit(user);

  const existingMemory = await prisma.memory.findUnique({
    where: {
      userId_characterId: {
        userId,
        characterId,
      },
    },
    select: {
      summary: true,
      createdAt: true,
      lastSummarizedAt: true,
      summarizedMessageCount: true,
    },
  });

  const allMessages = await prisma.message.findMany({
    where: { userId, characterId },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true, createdAt: true },
  });

  if (existingMemory) {
    const since = existingMemory.lastSummarizedAt ?? existingMemory.createdAt;
    const newMessages = allMessages.filter((message) => message.createdAt > since);
    const newTokens = newMessages.reduce((sum, message) => sum + countTokens(message.content), 0);

    if (
      newMessages.length < config.refreshMessageThreshold &&
      newTokens < config.refreshTokenThreshold
    ) {
      infoLog(
        "Memory",
        `Skipped refresh (new: ${newMessages.length} msgs, ${newTokens} tokens; threshold: ${config.refreshMessageThreshold} msgs / ${config.refreshTokenThreshold} tokens)`
      );
      return existingMemory.summary;
    }

    const historyToChapter = getHistoryForSummary(newMessages);
    if (historyToChapter.length === 0) {
      return existingMemory.summary;
    }

    return updateArcWithChapter(
      userId,
      characterId,
      apiKey,
      existingMemory.summary,
      existingMemory.summarizedMessageCount ?? 0,
      historyToChapter,
      config,
      plan
    );
  }

  const threshold = Math.floor(maxContextTokens * config.thresholdRatio);
  const totalTokens = allMessages.reduce((sum, message) => sum + countTokens(message.content), 0);

  if (totalTokens <= threshold) {
    infoLog(
      "Memory",
      `Skipped create (total: ${allMessages.length} msgs, ${totalTokens} tokens; threshold: ${threshold})`
    );
    return null;
  }

  const historyToSummarize = getHistoryForSummary(allMessages);
  if (historyToSummarize.length === 0) {
    return null;
  }

  return createArcSummary(userId, characterId, apiKey, historyToSummarize, config, plan);
}

export async function readChatMemorySummary(
  userId: string,
  characterId: string
): Promise<string | null> {
  const existingMemory = await prisma.memory.findUnique({
    where: { userId_characterId: { userId, characterId } },
    select: { summary: true },
  });
  return existingMemory?.summary?.trim() || null;
}

export function appendMemoryToSystemPrompt(
  systemPrompt: string,
  summary: string | null,
  locale?: string
): string {
  if (!summary?.trim()) {
    return systemPrompt;
  }

  const heading = locale === "en" ? "Brief backstory" : "Краткая предыстория";
  return `${systemPrompt}\n\n${heading}: ${summary.trim()}`;
}

export async function forceRefreshMemorySummary(
  userId: string,
  characterId: string,
  apiKey: string,
  user?: {
    subscriptionType?: string | null;
    subscriptionEnd?: Date | string | null;
  }
): Promise<string | null> {
  await ensureMemoryHierarchyColumns();

  const loadedUser =
    user ??
    (await prisma.user.findUnique({
      where: { id: userId },
      select: { subscriptionType: true, subscriptionEnd: true },
    }));
  const { config, plan } = getSummaryConfigForUser(loadedUser ?? {});

  const existingMemory = await prisma.memory.findUnique({
    where: { userId_characterId: { userId, characterId } },
    select: {
      summary: true,
      createdAt: true,
      lastSummarizedAt: true,
      summarizedMessageCount: true,
    },
  });

  const allMessages = await prisma.message.findMany({
    where: { userId, characterId },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true, createdAt: true },
  });

  if (allMessages.length === 0) {
    return null;
  }

  if (!existingMemory) {
    const historyToSummarize =
      allMessages.length > KEEP_RECENT_MESSAGES
        ? getHistoryForSummary(allMessages)
        : allMessages;
    return createArcSummary(userId, characterId, apiKey, historyToSummarize, config, plan);
  }

  const since = existingMemory.lastSummarizedAt ?? existingMemory.createdAt;
  const newMessages = allMessages.filter((message) => message.createdAt > since);
  const chapterMessages =
    allMessages.length <= KEEP_RECENT_MESSAGES
      ? allMessages
      : getHistoryForSummary(newMessages.length > 0 ? newMessages : allMessages);

  if (chapterMessages.length === 0) {
    return existingMemory.summary;
  }

  return updateArcWithChapter(
    userId,
    characterId,
    apiKey,
    existingMemory.summary,
    existingMemory.summarizedMessageCount ?? 0,
    chapterMessages,
    config,
    plan
  );
}
