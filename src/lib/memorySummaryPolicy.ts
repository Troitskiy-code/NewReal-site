import { MEMORY_STATUSES } from "./memoryNarrative";

/** Generation includes JSON bookkeeping; the persisted tariff allowance is separate. */
export const MAX_SUMMARY_GENERATION_TOKENS = 4096;
/** Items the stored allowance can hold at ~220 tokens per full 600-character item. Ten items for
 * 1500 tokens made the model write ~2500 tokens, past the 90 s timeout, while the renderer could
 * keep only five of them (prod 2026-10-24). */
export const summaryItemLimit = (storedLimit: number) => Math.min(10, Math.max(1, Math.floor(storedLimit / 220)));
/** Past items a merge may pin: all but two, which stay for the new messages (4 of 6 at 1500).
 * Two past items had to hold a whole 171-message story, so the restaurant date and the decision to
 * be a couple washed out after eight merges with every model tried (eval 2026-10-24). */
export const pastItemLimit = (storedLimit: number) => {
  const items = summaryItemLimit(storedLimit);
  return Math.max(Math.min(2, items), items - 2);
};
/** Share of the stored allowance the pinned past may fill, so the new scenes always fit. */
export const PAST_BUDGET_SHARE = 0.6;
/** Provider-side item length. 1200 characters invited a scene-by-scene retelling: ~3000 tokens for
 * 28 messages, past the 90 s timeout and the stored allowance (prod 2026-10-24). */
export const SUMMARY_ITEM_MAX_CHARS = 600;
/** The renderer enforces the stored allowance, so generation follows what the schema lets the model
 * write (~250 tokens per 600-character item with its sources). The stored allowance alone cut long
 * stories mid-answer on every attempt (prod 2026-10-24, 2634 of a 1500 allowance). */
export function summaryGenerationLimit(storedLimit: number): number {
  return Math.min(MAX_SUMMARY_GENERATION_TOKENS,
    Math.max(768, Math.ceil(storedLimit * 1.5) + 384, summaryItemLimit(storedLimit) * 250));
}

export type MemorySummaryFailure = "MEMORY_SUMMARY_TRUNCATED" | "MEMORY_SUMMARY_EMPTY_RESPONSE"
  | "MEMORY_SUMMARY_INVALID_JSON" | "MEMORY_SUMMARY_INVALID_ITEMS" | "MEMORY_SUMMARY_UNSUPPORTED_ITEM"
  | "MEMORY_SUMMARY_EMPTY_RESULT" | "MEMORY_SUMMARY_NO_FITTING_SOURCE";
/** Why one provider item was refused. Fatal reasons indicate invented or malformed output;
 * limit reasons can occur in a schema-valid answer and only drop that item. */
export type MemorySummaryItemReason = "not_object" | "unknown_field" | "invalid_section" | "invalid_status"
  | "invalid_text" | "invalid_sources" | "unknown_source" | "blank_text" | "text_too_long" | "too_many_sources";
/** Only enums and counters: never item text or source ids. */
export type MemorySummaryDetail = { validationReason: MemorySummaryItemReason; itemIndex: number;
  itemSection?: string; itemSources?: number; rejected?: number };
export class MemorySummaryError extends Error {
  constructor(readonly code: MemorySummaryFailure, readonly detail?: MemorySummaryDetail) {
    super(code); this.name = "MemorySummaryError";
  }
}

/** Deterministic size limits need editing/smaller input, not another immediate AI call. */
export function isDeferredSummaryFailure(error: unknown): boolean {
  return error instanceof MemorySummaryError && error.code === "MEMORY_SUMMARY_NO_FITTING_SOURCE"
    || error instanceof Error && error.name === "MemorySummaryInputError";
}

export function groundedSummaryFormat(sourceIds: string[], storedLimit: number) {
  return { type: "json_schema", json_schema: { name: "grounded_memory", strict: true, schema: {
    type: "object", additionalProperties: false, required: ["items"], properties: { items: {
      type: "array", minItems: 1, maxItems: summaryItemLimit(storedLimit),
      items: { type: "object", additionalProperties: false, required: ["section", "text", "status", "sources"], properties: {
        section: { type: "string", enum: ["past", "story", "state", "decisions", "plans", "events"] },
        text: { type: "string", minLength: 1, maxLength: SUMMARY_ITEM_MAX_CHARS },
        status: { type: "string", enum: [...MEMORY_STATUSES] },
        sources: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", enum: sourceIds } },
      } },
    } },
  } } };
}

/** `{"items":[…` cut at the token limit: the complete item objects, closed as a valid answer, or
 * null. An unfinished item is never repaired; its text could stop before a negation. */
export function completeSummaryItems(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false, lastItemEnd = -1;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
    } else if (char === "\"") inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      // Root object = 1, items array = 2: an item object closes back to depth 2.
      if (char === "}" && depth === 2) lastItemEnd = index;
    }
  }
  return lastItemEnd < 0 ? null : `${text.slice(start, lastItemEnd + 1)}]}`;
}

export function readSummaryResponse(data: { choices?: Array<{ finish_reason?: string | null;
  message?: { content?: unknown } }> }): { text: string; finishReason: string } {
  const choice = data?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
  if (choice?.finish_reason === "length") {
    // The end of a long answer is lost, not its beginning: keep the items the model finished.
    const complete = completeSummaryItems(text);
    if (!complete) throw new MemorySummaryError("MEMORY_SUMMARY_TRUNCATED");
    return { text: complete, finishReason: "length" };
  }
  if (!text) throw new MemorySummaryError("MEMORY_SUMMARY_EMPTY_RESPONSE");
  return { text, finishReason: choice?.finish_reason === "stop" ? "stop" : "other" };
}
