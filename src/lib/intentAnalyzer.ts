import axios from "axios";
import { debugLog, errorLog } from "@/lib/logger";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const INTENT_MODEL = "google/gemma-4-31b-it";
const MIN_INTENT_CONFIDENCE = 0.6;

export const USER_INTENTS = ["general", "story", "fact", "question", "action"] as const;

export type UserIntent = (typeof USER_INTENTS)[number];

export type IntentAnalysis = {
  intent: UserIntent;
  confidence: number;
};

export type IntentSource = "rules" | "model" | "low-confidence" | "fallback";

const INTENT_PROMPT = `Ты — классификатор намерений пользователя в ролевой игре.
Определи тип сообщения по следующим категориям:

general: общий диалог, приветствие, светская беседа, не требующая фактов.

story: развитие сюжета, описание действий, погружение в историю.

fact: запрос конкретной информации о мире, персонаже, прошлом (например, "Кто убил короля?", "Где находится артефакт?").

question: общий вопрос, требующий ответа, но не обязательно фактологический (например, "Как ты себя чувствуешь?", "Что ты думаешь об этом?").

action: конкретное действие персонажа (например, "Я открываю дверь", "Я атакую врага").

Важно: для fact и question необходимо указывать их только в том случае, если сообщение явно содержит запрос информации, который может быть найден в прошлых диалогах (т.е. требует RAG). Если вопрос общий или риторический, классифицируй как general.

Ответь только JSON-объектом: { "intent": "general" | "story" | "fact" | "question" | "action", "confidence": число от 0 до 1 }.`;

const QUESTION_WORD_RE =
  /(?:^|[^\p{L}])(?:кто|что|где|когда|почему|как|зачем|сколько|какой|какая|какие|who|what|where|when|why|how|which)(?=[^\p{L}]|$)/iu;

const QUESTION_START_RE =
  /^(?:кто|что|где|когда|почему|как|зачем|сколько|какой|какая|какие|who|what|where|when|why|how|which)(?:[^\p{L}]|$)/iu;

const FACT_WORD_RE =
  /(?:^|[^\p{L}])(?:кто|где|когда|почему|зачем|сколько|какой|какая|какие|who|where|when|why|which)(?=[^\p{L}]|$)/iu;

const RHETORICAL_RE =
  /(?:как дела|как ты(?:\s+себя)?|как ты себя чувствуешь|что ты думаешь|что нового|what do you think|how are you|how do you feel)/iu;

const FALLBACK_INTENT: IntentAnalysis = { intent: "general", confidence: 0 };

function isUserIntent(value: unknown): value is UserIntent {
  return typeof value === "string" && (USER_INTENTS as readonly string[]).includes(value);
}

function parseIntentPayload(raw: string): IntentAnalysis | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }
  const embedded = trimmed.match(/\{[\s\S]*\}/);
  if (embedded?.[0]) {
    candidates.push(embedded[0]);
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { intent?: unknown; confidence?: unknown };
      if (!isUserIntent(parsed.intent)) continue;

      const confidence =
        typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
          ? Math.min(1, Math.max(0, parsed.confidence))
          : 0.7;

      return { intent: parsed.intent, confidence };
    } catch {
      continue;
    }
  }

  return null;
}

function stripOuterPunctuation(text: string): string {
  return text.trim().replace(/^["«»„“'\s]+/, "").replace(/["»“']+$/g, "");
}

function hasQuestionMark(text: string): boolean {
  return /[?？]\s*$/.test(text.trim());
}

function hasSpecificEntity(text: string): boolean {
  if (/["«»„“][^"»“]+["»“]/.test(text)) return true;
  if (/\d/.test(text)) return true;

  const tokens = text.trim().split(/\s+/).filter(Boolean);
  return tokens.slice(1).some((token) => {
    const cleaned = token.replace(/^[("'«„]+/, "").replace(/[)"'»,.!?:;]+$/g, "");
    return /^[A-ZА-ЯЁ][\p{L}'-]+/u.test(cleaned);
  });
}

function isQuestionShaped(text: string): boolean {
  if (hasQuestionMark(text)) return true;
  return QUESTION_START_RE.test(stripOuterPunctuation(text));
}

export function classifyIntentByRules(userMessage: string): IntentAnalysis | null {
  const text = userMessage.trim();
  if (!text || !QUESTION_WORD_RE.test(text) || !isQuestionShaped(text)) {
    return null;
  }

  if (RHETORICAL_RE.test(text)) {
    return { intent: "general", confidence: 0.86 };
  }

  if (FACT_WORD_RE.test(text) || (/(?:^|[^\p{L}])(?:что|what)(?=[^\p{L}]|$)/iu.test(text) && hasSpecificEntity(text))) {
    return { intent: "fact", confidence: 0.88 };
  }

  return { intent: "question", confidence: 0.82 };
}

export function applyIntentConfidenceGuard(
  analysis: IntentAnalysis,
  userMessage: string
): IntentAnalysis & { source: IntentSource } {
  if (analysis.confidence >= MIN_INTENT_CONFIDENCE) {
    return { ...analysis, source: "model" };
  }

  debugLog(
    "Intent",
    `low-confidence fallback general confidence=${analysis.confidence.toFixed(2)} rawIntent=${analysis.intent} message=${userMessage.slice(0, 240)}`
  );
  return { intent: "general", confidence: analysis.confidence, source: "low-confidence" };
}

function logIntent(analysis: IntentAnalysis, source: IntentSource) {
  debugLog(
    "Intent",
    `intent=${analysis.intent} confidence=${analysis.confidence.toFixed(2)} source=${source}`
  );
}

export async function analyzeIntent(userMessage: string, apiKey: string): Promise<IntentAnalysis> {
  const text = userMessage.trim();
  if (!text) {
    debugLog("Intent", "empty message, fallback general");
    return FALLBACK_INTENT;
  }

  const fromRules = classifyIntentByRules(text);
  if (fromRules) {
    logIntent(fromRules, "rules");
    return fromRules;
  }

  try {
    const response = await axios.post(
      `${KODIKROUTER_URL}/chat/completions`,
      {
        model: INTENT_MODEL,
        messages: [
          { role: "system", content: INTENT_PROMPT },
          { role: "user", content: text },
        ],
        max_tokens: 80,
        temperature: 0,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const raw = response.data?.choices?.[0]?.message?.content ?? "";
    const parsed = parseIntentPayload(typeof raw === "string" ? raw : String(raw));
    if (!parsed) {
      debugLog("Intent", "unparseable response, fallback general:", String(raw).slice(0, 200));
      return FALLBACK_INTENT;
    }

    const guarded = applyIntentConfidenceGuard(parsed, text);
    logIntent(guarded, guarded.source);
    return { intent: guarded.intent, confidence: guarded.confidence };
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    errorLog("Intent", `analysis failed, fallback general status=${status ?? "network"}`);
    return FALLBACK_INTENT;
  }
}
