import { meteredKiePost } from "./aiCostTelemetry";

/**
 * Optional summary route: GPT-6 Luna through Kie, tried before DeepInfra when enabled. With chapter
 * summaries it kept 42–49% of a 171-message story's key beats against 69–82% for Gemma 4 Turbo on
 * DeepInfra, the default (eval 2026-10-24). About $0.005 per rebuild.
 */
export const KIE_SUMMARY_MODEL = "gpt-6-luna";
const KIE_RESPONSES_URL = "https://api.kie.ai/codex/v1/responses";
/** Kie's gateway cuts a non-streamed answer at ~100 s (code 524); Luna answered a chunk in 17–45 s. */
const KIE_SUMMARY_TIMEOUT_MS = 75_000;

/** Opt-in: SUMMARY_KIE_ENABLED=true and a Kie key. Otherwise summaries go to DeepInfra only. */
export function kieSummaryEnabled(): boolean {
  return process.env.SUMMARY_KIE_ENABLED === "true" && Boolean(process.env.KIE_API_KEY?.trim());
}

export class KieTextError extends Error {
  constructor(readonly reason: string) { super("Kie text request failed"); this.name = "KieTextError"; }
}

type JsonSchemaFormat = { json_schema: { name: string; schema: unknown } };
type ResponsesBody = { code?: unknown; status?: unknown; output_text?: unknown; data?: unknown;
  output?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>; usage?: { output_tokens?: unknown } };

/** One strict-JSON summary answer, returned in the chat-completions shape readSummaryResponse reads. */
export async function requestKieSummary(system: string, user: string, maxOutputTokens: number, format: JsonSchemaFormat) {
  const response = await meteredKiePost<ResponsesBody>("summary", KIE_RESPONSES_URL, {
    model: KIE_SUMMARY_MODEL, stream: false, reasoning: { effort: "low" },
    input: [{ role: "system", content: system }, { role: "user", content: user }],
    text: { format: { type: "json_schema", name: format.json_schema.name, strict: true, schema: format.json_schema.schema } },
    // Reasoning tokens count here too; Luna spent ~100 per summary chunk at low effort.
    max_output_tokens: maxOutputTokens,
  }, { headers: { Authorization: `Bearer ${process.env.KIE_API_KEY?.trim()}`, "Content-Type": "application/json" }, timeout: KIE_SUMMARY_TIMEOUT_MS });
  let data = response.data ?? {};
  if (typeof data.code === "number" && data.code !== 200) throw new KieTextError(`code_${data.code}`);
  if (data.data && typeof data.data === "object" && !data.output && data.output_text === undefined) data = data.data as ResponsesBody;
  const text = typeof data.output_text === "string" ? data.output_text
    : (data.output ?? []).flatMap(item => item.content ?? []).filter(part => part.type === "output_text")
      .map(part => typeof part.text === "string" ? part.text : "").join("");
  return { choices: [{ finish_reason: data.status === "incomplete" ? "length" : "stop", message: { content: text } }],
    usage: { completion_tokens: Number(data.usage?.output_tokens) || 0 } };
}
