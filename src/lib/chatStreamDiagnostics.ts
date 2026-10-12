// Server consumer wrapper. Keep node/Prisma/logger imports out of client-shared chatStream.ts.
import { consumeOpenAIChatCompletion as consumeCompletion } from "./chatStream";
import { aiCostDiagnosticContext } from "./aiCostTelemetry";
import { errorLog, toSafeDiagnostic } from "./logger";

export async function consumeOpenAIChatCompletion(
  stream: ReadableStream<Uint8Array>, onDelta: (text: string) => void,
  signal?: AbortSignal, onThinking?: () => void
) {
  return consumeCompletion(stream, onDelta, signal, onThinking, (error, stage, fields) => {
    let cause: unknown;
    try { if (error instanceof Error) cause = error.cause; } catch { /* Ignore hostile getters. */ }
    errorLog("ChatDiagnostics", "consumer failed", { ...aiCostDiagnosticContext(),
      stage, reason: "consumer_error", ...fields }, toSafeDiagnostic(error), toSafeDiagnostic(cause));
  });
}

export async function consumeOpenAIChatStream(
  stream: ReadableStream<Uint8Array>, onDelta: (text: string) => void, signal?: AbortSignal
) { return (await consumeOpenAIChatCompletion(stream, onDelta, signal)).text; }
