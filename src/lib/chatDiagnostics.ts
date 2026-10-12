import { errorLog, toSafeDiagnostic } from "./logger";

/** Never use an exception message, provider body or arbitrary abort reason as a log label. */
export function chatTransportDiagnostic(error: unknown, signal?: AbortSignal | null) {
  let timeoutStage: "first_byte" | "idle" | "total" | undefined;
  try {
    const reason = signal?.reason;
    if (signal?.aborted && reason instanceof Error && reason.name === "TimeoutError") {
      const stage = (reason as Error & { stage?: unknown }).stage;
      if (stage === "first_byte" || stage === "idle" || stage === "total") timeoutStage = stage;
    }
  } catch { /* Hostile errors must not break diagnostics. */ }
  let cause: unknown;
  try { if (error instanceof Error) cause = error.cause; } catch { /* Ignore getters. */ }
  return {
    fields: { reason: timeoutStage ? "timeout" : signal?.aborted ? "aborted" : "transport_error", timeoutStage },
    error: toSafeDiagnostic(error), cause: toSafeDiagnostic(cause),
  };
}

export function logChatTransportFailure(context: Record<string, unknown>, error: unknown, signal?: AbortSignal | null) {
  const diagnostic = chatTransportDiagnostic(error, signal);
  errorLog("ChatDiagnostics", "attempt failed", { ...context, ...diagnostic.fields }, diagnostic.error, diagnostic.cause);
}
