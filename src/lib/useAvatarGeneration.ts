"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { showError, showSuccess } from "./toast";
import { METRIKA_GOALS, reachGoal } from "./metrika";

type Limit = { tokensUsedThisMonth: number; monthlyLimit: number; monthlyRemaining: number };
type Job = { jobId?: string; clientKey?: string; scope?: string; state: string; imageUrl?: string; error?: string; tokenStatus?: Limit };
export function useAvatarGeneration(scope: string, onImage: (image: string) => void, onLimits: (limits: Limit) => void) {
  const { data: session, status } = useSession();
  const userId = session?.user?.id;
  const [job, setJob] = useState<Job>({ state: "none" });
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState("");
  const [deliveredId, setDeliveredId] = useState<string | null>(null);
  const callbacks = useRef({ onImage, onLimits });
  useEffect(() => { callbacks.current = { onImage, onLimits }; }, [onImage, onLimits]);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const watching = useRef(false);
  const delivered = useRef<string | null>(null);
  const polling = useRef(false);
  const attemptKey = useRef<string | null>(null);

  function applyImage(value: Job, announce = true) {
    if (!value.jobId || !value.imageUrl || delivered.current === value.jobId) return;
    delivered.current = value.jobId;
    setDeliveredId(value.jobId);
    setJob({ ...value });
    callbacks.current.onImage(value.imageUrl);
    try {
      const key = `nv-kie-goal:${userId}:${value.jobId}`;
      if (!sessionStorage.getItem(key)) { reachGoal(METRIKA_GOALS.generateAvatar); sessionStorage.setItem(key, "1"); }
    } catch { reachGoal(METRIKA_GOALS.generateAvatar); }
    if (announce) showSuccess("Изображение готово");
  }
  function accept(value: Job) {
    if (value.scope && value.scope !== scope) return;
    // A recovered POST is acknowledged only by its own idempotency key, not an older scope result.
    if (value.clientKey && value.jobId) {
      const key = `nv-kie-request:${userId}:${scope}`;
      try { attemptKey.current ??= sessionStorage.getItem(key); } catch { /* in-tab fallback */ }
      if (attemptKey.current === value.clientKey) {
        attemptKey.current = null;
        try { sessionStorage.removeItem(key); } catch { /* in-tab fallback */ }
      }
    }
    setJob(value);
    if (value.tokenStatus) callbacks.current.onLimits(value.tokenStatus);
    if (value.state === "succeeded" && watching.current) applyImage(value);
    if (["failed", "uncertain"].includes(value.state)) {
      setNotice(value.error ?? "Не удалось получить изображение");
      if (watching.current) showError(value.error ?? "Не удалось получить изображение");
    } else setNotice("");
  }
  async function readStatus(jobId?: string, recovering = false) {
    if (polling.current) return;
    polling.current = true;
    const current = ++sequence.current;
    try {
      const query = jobId ? `jobId=${encodeURIComponent(jobId)}` : `scope=${encodeURIComponent(scope)}`;
      const response = await fetch(`/api/generate-avatar?${query}`, { cache: "no-store", signal: controller.current?.signal });
      const data: Job = await response.json();
      if (current !== sequence.current || controller.current?.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || "Не удалось проверить генерацию");
      // Resume an outstanding run after reload. A historical completed image is restored explicitly.
      if (recovering && ["creating", "pending"].includes(data.state)) watching.current = true;
      accept(data);
    } catch (error) {
      if (current === sequence.current && !controller.current?.signal.aborted) {
        setNotice(error instanceof Error ? error.message : "Проверка результата временно недоступна");
      }
    } finally { polling.current = false; }
  }
  useEffect(() => {
    if (status !== "authenticated" || !userId) return;
    const activeController = new AbortController();
    controller.current = activeController;
    void readStatus(undefined, true);
    return () => { activeController.abort(); };
    // A keyed CharacterForm remounts when account/card/mode changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, status, userId]);
  useEffect(() => {
    if (!["creating", "pending"].includes(job.state)) return;
    const timer = setInterval(() => { void readStatus(job.jobId); }, 5_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.jobId, job.state]);

  async function start(payload: Record<string, unknown>) {
    if (starting || ["creating", "pending", "uncertain"].includes(job.state)) return;
    setStarting(true); setNotice(""); watching.current = true;
    const current = ++sequence.current;
    try {
      const storageKey = `nv-kie-request:${userId}:${scope}`;
      try { attemptKey.current ??= sessionStorage.getItem(storageKey); } catch { /* in-tab fallback */ }
      attemptKey.current ??= crypto.randomUUID();
      try { sessionStorage.setItem(storageKey, attemptKey.current); } catch { /* in-tab fallback */ }
      const response = await fetch("/api/generate-avatar", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, scope, clientKey: attemptKey.current }), signal: controller.current?.signal });
      const data: Job = await response.json();
      if (current !== sequence.current || controller.current?.signal.aborted) return;
      if (data.jobId || [400, 401, 402, 409, 413].includes(response.status)) {
        attemptKey.current = null;
        try { sessionStorage.removeItem(storageKey); } catch { /* in-tab fallback */ }
      }
      if (!response.ok) throw new Error(data.error || "Не удалось запустить генерацию");
      accept(data);
    } catch (error) {
      if (!controller.current?.signal.aborted) {
        setNotice(error instanceof Error ? error.message : "Проверьте статус генерации");
        // Do not blindly send another paid POST after a lost response.
        await readStatus(undefined, true);
      }
    } finally { if (!controller.current?.signal.aborted) setStarting(false); }
  }
  return { busy: starting || ["creating", "pending"].includes(job.state), blocked: job.state === "uncertain",
    notice, state: job.state, canRestore: job.state === "succeeded" && deliveredId !== job.jobId,
    restore: () => applyImage(job), refresh: () => readStatus(undefined, true), start };
}
