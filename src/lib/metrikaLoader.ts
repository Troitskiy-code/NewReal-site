export const METRIKA_TAG_PRIMARY = "https://mc.yandex.com/metrika/tag.js";
export const METRIKA_TAG_FALLBACK = "https://mc.yandex.ru/metrika/tag.js";

export type MetrikaLoadState = "idle" | "loading" | "loaded" | "failed";

type YmFn = ((counterId: number, method: string, ...args: unknown[]) => void) & {
  a?: unknown[];
  l?: number;
};

declare global {
  interface Window {
    ym?: YmFn;
    __nvMetrika?: {
      counterId: string;
      loadState: MetrikaLoadState;
      counterReady: boolean;
      source: "primary" | "fallback" | null;
      generation: number;
      inited: boolean;
      fallbackStarted: boolean;
    };
    [key: `yaCounter${string}`]: unknown;
  }
}

const MAX_SOURCE_ATTEMPTS = 2;
const MAX_NETWORK_CYCLES = 3;
const SCRIPT_TIMEOUT_MS = 8000;

const readyWaiters = new Set<(ready: boolean) => void>();
let networkCycles = 0;
let onlineBound = false;
const loadTimers = new Map<number, number>();

function readyEventName(counterId: string) {
  return `yacounter${counterId}inited`;
}

function win(): Window | null {
  if (typeof window === "undefined") return null;
  return window;
}

function state() {
  return win()?.__nvMetrika ?? null;
}

function nativeCounter(counterId: string): unknown {
  const w = win();
  if (!w) return null;
  return w[`yaCounter${counterId}`];
}

function ensureState(counterId: string) {
  const w = win();
  if (!w) return null;
  if (!w.__nvMetrika || w.__nvMetrika.counterId !== counterId) {
    w.__nvMetrika = {
      counterId,
      loadState: w.__nvMetrika?.loadState ?? "idle",
      counterReady: w.__nvMetrika?.counterReady ?? false,
      source: w.__nvMetrika?.source ?? null,
      generation: w.__nvMetrika?.generation ?? 0,
      inited: w.__nvMetrika?.inited ?? false,
      fallbackStarted: w.__nvMetrika?.fallbackStarted ?? false,
    };
  }
  return w.__nvMetrika;
}

export function getMetrikaLoadState(): MetrikaLoadState {
  return state()?.loadState ?? "idle";
}

export function isMetrikaCounterReady(): boolean {
  return Boolean(state()?.counterReady);
}

export function getMetrikaScriptSource(): "primary" | "fallback" | null {
  return state()?.source ?? null;
}

function notifyReady() {
  for (const waiter of [...readyWaiters]) waiter(true);
}

export function subscribeMetrikaReady(listener: (ready: boolean) => void): () => void {
  if (isMetrikaCounterReady()) {
    listener(true);
    return () => undefined;
  }
  readyWaiters.add(listener);
  return () => {
    readyWaiters.delete(listener);
  };
}

export function waitForMetrika(timeoutMs = 8000): Promise<boolean> {
  if (isMetrikaCounterReady()) return Promise.resolve(true);
  if (typeof window === "undefined") return Promise.resolve(false);

  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      resolve(isMetrikaCounterReady());
    }, timeoutMs);
    const unsubscribe = subscribeMetrikaReady(() => {
      window.clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

export function ensureYmQueue(): void {
  const w = win();
  if (!w) return;
  if (typeof w.ym === "function") return;
  const queued: YmFn = function ym() {
    (queued.a = queued.a || []).push(arguments);
  };
  queued.l = Date.now();
  w.ym = queued;
}

function markCounterReady() {
  const current = state();
  if (!current) return;
  current.counterReady = true;
  current.loadState = "loaded";
  notifyReady();
}

function attachReadyListener(counterId: string, generation: number) {
  const w = win();
  if (!w) return;
  const event = readyEventName(counterId);
  const onReady = () => {
    const current = state();
    if (!current || current.generation !== generation) return;
    markCounterReady();
  };
  w.addEventListener(event, onReady, { once: true });
  if (nativeCounter(counterId)) markCounterReady();
}

function initCounter(counterId: string, generation: number) {
  const w = win();
  const current = state();
  if (!w || !current) return;
  if (current.generation !== generation) return;
  if (current.inited) {
    attachReadyListener(counterId, generation);
    return;
  }
  if (typeof w.ym !== "function") return;
  attachReadyListener(counterId, generation);
  current.inited = true;
  w.ym(Number(counterId), "init", {
    triggerEvent: true,
    clickmap: true,
    trackLinks: true,
    accurateTrackBounce: true,
    webvisor: false,
  });
  if (nativeCounter(counterId)) markCounterReady();
}

function existingLoadedScript(src: string): HTMLScriptElement | null {
  const w = win();
  if (!w) return null;
  const scripts = w.document.getElementsByTagName("script");
  for (let i = 0; i < scripts.length; i += 1) {
    const el = scripts[i];
    if (el.src === src && el.dataset.nvLoaded === "1") return el;
  }
  return null;
}

function clearLoadTimer(generation: number) {
  const w = win();
  const timer = loadTimers.get(generation);
  if (timer && w) w.clearTimeout(timer);
  loadTimers.delete(generation);
}

function startFallback(counterId: string, generation: number) {
  const current = state();
  if (!current || current.generation !== generation) return;
  if (current.fallbackStarted || current.counterReady) return;
  current.fallbackStarted = true;
  loadSources(counterId, generation, 1);
}

function insertScript(counterId: string, src: string, generation: number, source: "primary" | "fallback") {
  const w = win();
  const current = state();
  if (!w || !current) return;
  if (existingLoadedScript(src)) {
    current.source = source;
    current.loadState = "loaded";
    initCounter(counterId, generation);
    return;
  }

  const script = w.document.createElement("script");
  script.async = true;
  script.src = src;
  script.dataset.nvMetrika = source;
  const timer = w.setTimeout(() => {
    if (state()?.generation !== generation) return;
    script.onload = null;
    script.onerror = null;
    if (source === "primary") startFallback(counterId, generation);
    else current.loadState = "failed";
  }, SCRIPT_TIMEOUT_MS);
  loadTimers.set(generation, timer);
  script.onload = () => {
    const latest = state();
    if (!latest || latest.generation !== generation) return;
    clearLoadTimer(generation);
    script.dataset.nvLoaded = "1";
    latest.source = source;
    latest.loadState = "loaded";
    initCounter(counterId, generation);
  };
  script.onerror = () => {
    const latest = state();
    if (!latest || latest.generation !== generation) return;
    clearLoadTimer(generation);
    if (source === "primary") {
      startFallback(counterId, generation);
      return;
    }
    latest.loadState = "failed";
  };
  const first = w.document.getElementsByTagName("script")[0];
  if (first?.parentNode) {
    first.parentNode.insertBefore(script, first);
  } else {
    (w.document.head ?? w.document.body ?? w.document.documentElement)?.appendChild?.(script);
  }
}

function loadSources(counterId: string, generation: number, index: number) {
  const current = state();
  if (!current || current.generation !== generation) return;
  if (index >= MAX_SOURCE_ATTEMPTS) {
    current.loadState = "failed";
    return;
  }
  current.loadState = "loading";
  const src = index === 0 ? METRIKA_TAG_PRIMARY : METRIKA_TAG_FALLBACK;
  insertScript(counterId, src, generation, index === 0 ? "primary" : "fallback");
}

function bindOnlineRetry(counterId: string) {
  const w = win();
  if (!w || onlineBound) return;
  onlineBound = true;
  w.addEventListener("online", () => {
    const current = state();
    if (!current || current.counterReady || current.loadState === "loading") return;
    if (current.loadState !== "failed") return;
    if (networkCycles >= MAX_NETWORK_CYCLES) return;
    networkCycles += 1;
    current.inited = false;
    current.fallbackStarted = false;
    current.loadState = "idle";
    window.setTimeout(() => startMetrikaLoader(counterId), 1500 * networkCycles);
  });
}

export function startMetrikaLoader(counterId: string): void {
  const w = win();
  if (!w || !counterId) return;
  const current = ensureState(counterId);
  if (!current) return;
  ensureYmQueue();
  bindOnlineRetry(counterId);
  if (current.counterReady) return;
  if (nativeCounter(counterId)) {
    markCounterReady();
    return;
  }
  if (current.inited && current.loadState === "loaded") {
    attachReadyListener(counterId, current.generation);
    return;
  }
  if (current.loadState === "loading") return;
  current.generation += 1;
  current.inited = false;
  current.fallbackStarted = false;
  loadSources(counterId, current.generation, 0);
}

export function resetMetrikaLoaderForTests(): void {
  const w = win();
  if (w) {
    for (const timer of loadTimers.values()) w.clearTimeout(timer);
    w.__nvMetrika = undefined;
  }
  loadTimers.clear();
  readyWaiters.clear();
  networkCycles = 0;
  onlineBound = false;
}
