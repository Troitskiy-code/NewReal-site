import { METRIKA_COUNTER_ID, METRIKA_GOALS, dispatchGoal, isMetrikaCounterReady } from "./metrika";
import { subscribeMetrikaReady } from "./metrikaLoader";
import type { ChatStreamEndEvent } from "./chatStream";

const STORAGE_KEY = `nv:acquisition:v1:${METRIKA_COUNTER_ID}`;
const VISIT_MS = 30 * 60 * 1000;
type Goal = "register" | "register_success" | "send_message" | "chat_engaged";
type Entry = { goal: Goal; owner: string | null; state: "pending" | "dispatched"; at: number };
type Dialog = { turns: string[]; lastAt: number; visit: string; engaged: boolean };
type Store = { events: Record<string, Entry>; dialogs: Record<string, Dialog> };
let memory: Store = { events: {}, dialogs: {} };
let actor: string | null = null;
let active = false;
let flushing = false;

const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const goals = new Set<Goal>(["register", "register_success", "send_message", "chat_engaged"]);
const canDispatch = (item: Entry) => item.owner === actor
  || (actor === "guest" && (item.goal === "register" || item.goal === "register_success"));

function load(): Store {
  if (typeof window === "undefined") return memory;
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null") as Store | null;
    if (saved?.events && saved?.dialogs) {
      for (const [key, value] of Object.entries(saved.events).slice(-512)) {
        if (value && goals.has(value.goal) && (value.owner === null || validId(value.owner))
          && (value.state === "pending" || value.state === "dispatched") && Number.isFinite(value.at)
          && Date.now() - value.at < 24 * 60 * 60 * 1000) {
          // A stored dispatched event must never be downgraded by a stale in-memory copy.
          if (!memory.events[key] || value.state === "dispatched") memory.events[key] = value;
        }
      }
      for (const [key, value] of Object.entries(saved.dialogs).slice(-64)) {
        if (value && Array.isArray(value.turns) && value.turns.length <= 256 && value.turns.every(validId) && validId(value.visit)
          && Number.isFinite(value.lastAt) && typeof value.engaged === "boolean"
          && Date.now() - value.lastAt < VISIT_MS && !memory.dialogs[key]) memory.dialogs[key] = value;
      }
    }
  } catch { /* Private mode / quota: keep in-tab state, never block a successful action. */ }
  return memory;
}

function save() {
  const now = Date.now();
  memory.events = Object.fromEntries(Object.entries(memory.events).filter(([, item]) => now - item.at < 86400000).slice(-512));
  memory.dialogs = Object.fromEntries(Object.entries(memory.dialogs).filter(([, item]) => now - item.lastAt < VISIT_MS).slice(-64));
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memory)); } catch { /* in-tab fallback */ }
}

async function flush() {
  if (!active || flushing || !isMetrikaCounterReady()) return;
  flushing = true;
  try {
    while (active && isMetrikaCounterReady()) {
      const next = Object.entries(load().events).find(([, item]) => item.state === "pending" && canDispatch(item));
      if (!next) break;
      const [key, item] = next;
      // Non-financial goals: dispatch at most once. An absent callback is not proof of delivery.
      item.state = "dispatched";
      save();
      const result = await dispatchGoal(item.goal, { event_version: 2 }, 1000);
      if (result.status === "not_ready") {
        memory.events[key].state = "pending";
        save();
        break;
      }
    }
  } finally { flushing = false; }
}

function enqueue(goal: Goal, eventId: string, owner: string | null) {
  const key = `${goal}:${eventId}`;
  if (load().events[key]) return;
  memory.events[key] = { goal, owner, state: "pending", at: Date.now() };
  save();
  void flush();
}

/** Called by AppShell, so pending events survive leaving the form/chat route. */
export function startAcquisitionGoals(currentActor: string | null): () => void {
  actor = currentActor;
  active = true;
  load();
  // Never dispatch an old account's queued actions in a new account's visit.
  for (const item of Object.values(memory.events)) {
    if (!canDispatch(item)) item.state = "dispatched";
  }
  save();
  const unsubscribe = subscribeMetrikaReady(() => { void flush(); });
  const resume = () => { void flush(); };
  window.addEventListener("online", resume);
  window.addEventListener("focus", resume);
  return () => { active = false; unsubscribe(); window.removeEventListener("online", resume); window.removeEventListener("focus", resume); };
}

export function trackSuccessfulRegistration(userId: unknown) {
  if (typeof window === "undefined" || !validId(userId)) return;
  enqueue(METRIKA_GOALS.registerSuccess, userId, userId);
  // Preserve the old goal identifier, but count success from now on.
  enqueue(METRIKA_GOALS.register, userId, userId);
}

export function trackSuccessfulChatTurn(event: ChatStreamEndEvent | null, context: {
  actor: string; characterId: string; userMessageId?: string;
}) {
  if (typeof window === "undefined" || !active || actor !== context.actor || !validId(context.characterId)) return;
  const userId = event?.userMessage?.id ?? context.userMessageId;
  if (!event || event.type !== "end" || !validId(userId) || !validId(event.assistantMessage?.id)
    || event.assistantMessage.role !== "assistant" || typeof event.assistantMessage.content !== "string" || !event.assistantMessage.content.trim()
    || (event.userMessage && (event.userMessage.role !== "user" || typeof event.userMessage.content !== "string" || !event.userMessage.content.trim()))) return;
  const identity = `${context.actor}:${context.characterId}:${userId}`;
  if (load().events[`send_message:${identity}`]) return;
  const key = `${context.actor}:${context.characterId}`;
  let dialog = memory.dialogs[key];
  if (!dialog || Date.now() - dialog.lastAt >= VISIT_MS) {
    dialog = { turns: [], lastAt: Date.now(), visit: crypto.randomUUID(), engaged: false };
    memory.dialogs[key] = dialog;
  }
  if (!dialog.turns.includes(userId)) dialog.turns.push(userId);
  dialog.turns = dialog.turns.slice(-256);
  dialog.lastAt = Date.now();
  enqueue(METRIKA_GOALS.sendMessage, identity, context.actor);
  if (dialog.turns.length >= 3 && !dialog.engaged) {
    dialog.engaged = true;
    enqueue(METRIKA_GOALS.chatEngaged, `${key}:${dialog.visit}`, context.actor);
  }
  save();
}
