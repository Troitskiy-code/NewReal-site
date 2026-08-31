import axios from "axios";

const KODIKROUTER_URL = "https://api.kodikrouter.ru/v1";
const INTENT_MODEL = "openai/gpt-4o-mini";

export const USER_INTENTS = ["general", "story", "fact", "question", "action"] as const;

export type UserIntent = (typeof USER_INTENTS)[number];

export type IntentAnalysis = {
  intent: UserIntent;
  confidence: number;
};

const INTENT_PROMPT =
  "Определи намерение пользователя: general (общий диалог), story (развитие сюжета), fact (запрос факта), question (вопрос), action (действие). Ответь JSON.";

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

const FALLBACK_INTENT: IntentAnalysis = { intent: "general", confidence: 0 };

export async function analyzeIntent(userMessage: string, apiKey: string): Promise<IntentAnalysis> {
  const text = userMessage.trim();
  if (!text) {
    console.log("[Intent] empty message, fallback general");
    return FALLBACK_INTENT;
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
      console.log("[Intent] unparseable response, fallback general:", String(raw).slice(0, 200));
      return FALLBACK_INTENT;
    }

    console.log(`[Intent] intent=${parsed.intent} confidence=${parsed.confidence.toFixed(2)}`);
    return parsed;
  } catch (error) {
    console.error("[Intent] analysis failed, fallback general", error);
    return FALLBACK_INTENT;
  }
}
