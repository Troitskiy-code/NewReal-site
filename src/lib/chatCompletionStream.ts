// Shared by the reply consumer and cost collector. Never retain error bodies.
const MAX_FRAME_CHARS = 1_000_000;

export type ChatCompletionFinishReason = "stop" | "length";
export type ChatStreamProtocolReason = "provider_error" | "sse_error" | "malformed_json"
  | "invalid_payload" | "oversized_frame" | "content_after_terminal" | "finish_after_done"
  | "conflicting_finish" | "content_filter" | "tool_calls" | "unsupported_finish"
  | "missing_done" | "missing_finish" | "empty_text";

export function extractChatStreamDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return "";
  const choice = choices[0] as Record<string, unknown>;
  const delta = choice.delta;
  if (delta && typeof delta === "object" && typeof (delta as Record<string, unknown>).content === "string") {
    return (delta as { content: string }).content;
  }
  if (typeof choice.text === "string") return choice.text;
  const message = choice.message;
  return message && typeof message === "object" && typeof (message as Record<string, unknown>).content === "string"
    ? (message as { content: string }).content : "";
}

/** True when a chunk carries reasoning text (DeepInfra: reasoning_content, OpenRouter-style: reasoning). */
export function hasChatStreamReasoning(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return false;
  const delta = (choices[0] as Record<string, unknown>).delta;
  if (!delta || typeof delta !== "object") return false;
  const { reasoning_content: content, reasoning } = delta as Record<string, unknown>;
  return (typeof content === "string" && content.length > 0) || (typeof reasoning === "string" && reasoning.length > 0);
}

export class ChatCompletionStreamError extends Error {
  readonly code = "incomplete_ai_stream";
  readonly __noRetry = true;

  constructor() {
    super("Не удалось получить полный ответ ИИ. Попробуйте отправить сообщение ещё раз.");
    this.name = "ChatCompletionStreamError";
  }
}

export class ChatCompletionStreamParser {
  private buffer = "";
  private data: string[] = [];
  private dataChars = 0;
  private event = "";
  private invalid = false;
  private done = false;
  private ended = false;
  private hasText = false;
  private hasReasoning = false;
  private frameCount = 0;
  private protocolReason: ChatStreamProtocolReason | null = null;
  private readonly onChunk: (chunk: Record<string, unknown>, emitText: boolean) => void;
  finishReason: ChatCompletionFinishReason | null = null;

  constructor(onChunk: (chunk: Record<string, unknown>, emitText: boolean) => void) { this.onChunk = onChunk; }

  push(text: string) {
    if (this.ended) throw new Error("Stream parser already ended");
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
    }
    if (this.buffer.length > MAX_FRAME_CHARS) {
      this.invalidate("oversized_frame");
      this.buffer = "";
    }
  }

  /** Only bounded categories and counters; never expose frame contents or provider error text. */
  diagnostics() {
    return {
      hasDone: this.done, hasText: this.hasText, hasReasoning: this.hasReasoning,
      finishReason: this.finishReason, frameCount: this.frameCount,
      protocolReason: this.protocolReason ?? (!this.done ? "missing_done"
        : this.finishReason === null ? "missing_finish" : !this.hasText ? "empty_text" : null),
    };
  }

  private invalidate(reason: ChatStreamProtocolReason) {
    this.invalid = true;
    this.protocolReason ??= reason;
  }

  end(): "completed" | "failed" {
    if (!this.ended) {
      if (this.buffer) this.consumeLine(this.buffer.replace(/\r$/, ""));
      this.buffer = "";
      this.consumeFrame();
      this.ended = true;
    }
    // length is a valid, truncated answer: the existing Continue flow applies.
    return !this.invalid && this.done && this.finishReason !== null && this.hasText ? "completed" : "failed";
  }

  private consumeLine(line: string) {
    if (!line) { this.consumeFrame(); return; }
    if (line.length > MAX_FRAME_CHARS) { this.invalidate("oversized_frame"); return; }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.event = value;
    if (field !== "data") return;
    this.dataChars += value.length + 1;
    if (this.dataChars > MAX_FRAME_CHARS) { this.invalidate("oversized_frame"); this.data = []; return; }
    this.data.push(value);
  }

  private consumeFrame() {
    const payload = this.data.join("\n").trim();
    if (this.event === "error") this.invalidate("sse_error");
    this.data = []; this.dataChars = 0; this.event = "";
    if (!payload) return;
    this.frameCount++;
    if (payload === "[DONE]") { this.done = true; return; }
    let chunk: unknown;
    try { chunk = JSON.parse(payload); } catch { this.invalidate("malformed_json"); return; }
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) { this.invalidate("invalid_payload"); return; }
    const record = chunk as Record<string, unknown>;
    if (record.error != null) this.invalidate("provider_error");
    this.hasReasoning ||= hasChatStreamReasoning(record);
    const beforeTerminal = !this.done && this.finishReason === null;
    const delta = extractChatStreamDelta(record);
    if (delta) {
      if (!beforeTerminal) this.invalidate("content_after_terminal");
      if (delta.trim()) this.hasText = true;
    }
    const choice = Array.isArray(record.choices) ? record.choices[0] : null;
    if (choice && typeof choice === "object" && choice.finish_reason != null) {
      const reason = choice.finish_reason;
      if (this.done) this.invalidate("finish_after_done");
      else if (reason !== "stop" && reason !== "length") {
        this.invalidate(reason === "content_filter" || reason === "tool_calls" ? reason : "unsupported_finish");
      }
      else if (this.finishReason !== null && this.finishReason !== reason) this.invalidate("conflicting_finish");
      else this.finishReason = reason;
    }
    // Usage on errors and after the terminal choice is still available to accounting.
    // Callback exceptions propagate; they must never be swallowed as JSON errors.
    this.onChunk(record, beforeTerminal && !this.invalid);
  }
}
