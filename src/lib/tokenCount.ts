import { encoding_for_model, type Tiktoken } from "tiktoken";

// Building the encoder costs tens of milliseconds of synchronous WASM work; encoding with
// an existing one costs well under a millisecond. Context assembly counts many messages.
let encoder: Tiktoken | null = null;

export function countTokens(text: string): number {
  try {
    encoder ??= encoding_for_model("gpt-4");
    return encoder.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}
