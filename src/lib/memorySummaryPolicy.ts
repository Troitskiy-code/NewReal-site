import { MEMORY_STATUSES } from "./memoryNarrative";

/** Generation includes JSON bookkeeping; the persisted tariff allowance is separate. */
export const MAX_SUMMARY_GENERATION_TOKENS = 4096;
export function summaryGenerationLimit(storedLimit: number): number {
  return Math.min(MAX_SUMMARY_GENERATION_TOKENS, Math.max(768, Math.ceil(storedLimit * 1.5) + 384));
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
      type: "array", minItems: 1, maxItems: Math.min(10, Math.max(1, Math.floor(storedLimit / 120))),
      items: { type: "object", additionalProperties: false, required: ["section", "text", "status", "sources"], properties: {
        section: { type: "string", enum: ["story", "state", "decisions", "plans", "events"] },
        text: { type: "string", minLength: 1, maxLength: 1200 },
        status: { type: "string", enum: [...MEMORY_STATUSES] },
        sources: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", enum: sourceIds } },
      } },
    } },
  } } };
}

export function readSummaryResponse(data: { choices?: Array<{ finish_reason?: string | null;
  message?: { content?: unknown } }> }): { text: string; finishReason: string } {
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === "length") throw new MemorySummaryError("MEMORY_SUMMARY_TRUNCATED");
  const text = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
  if (!text) throw new MemorySummaryError("MEMORY_SUMMARY_EMPTY_RESPONSE");
  return { text, finishReason: choice?.finish_reason === "stop" ? "stop" : "other" };
}
