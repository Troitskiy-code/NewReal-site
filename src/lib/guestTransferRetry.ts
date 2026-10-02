export type GuestTransferReply = { status: number; copied?: number; code?: string };

export class GuestTransferPendingError extends Error {
  constructor() { super("Guest transfer needs retry"); }
}

export function waitForGuestTransferRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

// At most nine requests; normal backoff stays below the transfer route's rate limit.
export async function waitForGuestTransfer(options: {
  request: () => Promise<GuestTransferReply>;
  signal: AbortSignal;
  onWaiting: () => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<number> {
  const delays = [1500, 2500, 5000, 8000, 12000, 15000, 15000, 15000];
  const sleep = options.sleep ?? waitForGuestTransferRetry;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    options.signal.throwIfAborted();
    let reply: GuestTransferReply;
    try { reply = await options.request(); }
    catch {
      options.signal.throwIfAborted();
      reply = { status: 503 };
    }
    options.signal.throwIfAborted();
    if (reply.status >= 200 && reply.status < 300) return reply.copied ?? 0;
    if (reply.status === 404 || reply.status === 410) return 0;
    const retryable = reply.code === "in_progress" || reply.status === 429 || reply.status >= 500;
    if (!retryable || attempt === delays.length) throw new GuestTransferPendingError();
    options.onWaiting();
    await sleep(reply.status === 429 ? 60_000 : delays[attempt], options.signal);
  }
  throw new GuestTransferPendingError();
}
