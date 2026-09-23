type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => void;
};

export const KODIK_RETRY_ERROR_MESSAGE =
  "Сервис временно недоступен. Мы попробовали 3 раза, но ИИ не ответил. Нажмите «Отправить» ещё раз через 10 секунд.";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function defaultShouldRetry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  if ((error as { __noRetry?: boolean }).__noRetry) {
    return false;
  }

  const named = error as { name?: string; code?: string; status?: number };
  if (named.name === "AbortError" || named.name === "TimeoutError") {
    return true;
  }

  const statusFromError =
    typeof named.status === "number"
      ? named.status
      : typeof (error as { response?: { status?: number } }).response?.status === "number"
        ? (error as { response: { status: number } }).response.status
        : undefined;

  if ("response" in error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (!status) return true;
    return status >= 500 || status === 429 || status === 408;
  }

  if (typeof statusFromError === "number") {
    return statusFromError >= 500 || statusFromError === 429 || statusFromError === 408;
  }

  const code = named.code;
  if (
    code &&
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ECONNABORTED", "ENOTFOUND"].includes(
      code
    )
  ) {
    return true;
  }

  if (error instanceof TypeError) return true;

  const message = errorMessage(error);
  return /fetch failed|failed to fetch|network|timeout|aborted|пустой поток ответа/i.test(message);
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 8000,
    shouldRetry = defaultShouldRetry,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        console.log(`[Retry] Success after ${attempt} attempts`);
      }
      return result;
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts) break;
      if (!shouldRetry(error)) throw error;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      console.warn(
        `[Retry] Attempt ${attempt} failed: ${errorMessage(error)}, retrying in ${delay}ms`
      );
      onRetry?.(attempt, error);

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.error("[Retry] All attempts failed");
  throw lastError;
}
