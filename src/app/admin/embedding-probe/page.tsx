"use client";
// TEMPORARY (2026-10-20): see src/lib/adminEmbeddingProbe.ts.
import { useEffect, useRef, useState } from "react";

type Summary = { model: string; sent: number; ok: number; http429: number; timeouts: number; otherErrors: number;
  errorCodes: Record<string, number>; dimensions: number | null; p10: number | null; p50: number | null; p90: number | null;
  p95: number | null; p99: number | null; max: number | null; pctOver1s: number | null; pctOver3s: number | null; pctOver5s: number | null;
  inputTokens: number; providerCostUsd: number; samplesMs: number[] };
type Status = { configured: boolean; models: string[]; networkRoute: string;
  limits: { minRounds: number; maxRounds: number; defaultRounds: number; requestTimeoutMs: number };
  job: { id: string; state: "running" | "finished" | "failed"; rounds: number; completedRounds: number; startedAt: number;
    finishedAt: number | null; networkRoute: string; results: Summary[] } | null };
const input = "w-full rounded-xl border border-wd-border bg-wd-bg p-3 text-wd-text";
const ms = (value: number | null) => value === null ? "—" : `${value}`;
const pct = (value: number | null) => value === null ? "—" : `${value}%`;
export default function EmbeddingProbeAdmin() {
  const [secret, setSecret] = useState(""), [status, setStatus] = useState<Status | null>(null);
  const [rounds, setRounds] = useState(80), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const generation = useRef(0);
  async function api(start = false) {
    const current = generation.current;
    const response = await fetch("/api/admin/embedding-probe", { method: start ? "POST" : "GET", cache: "no-store",
      headers: { Authorization: `Bearer ${secret}`, ...(start ? { "Content-Type": "application/json" } : {}) },
      ...(start ? { body: JSON.stringify({ rounds, confirmed }) } : {}) });
    const result = await response.json().catch(() => ({ error: `Сервер временно недоступен (HTTP ${response.status})` }));
    if (current !== generation.current) return;
    if (!response.ok) throw new Error(result.error ?? "Не удалось прочитать результат");
    setStatus(result);
  }
  async function act(start = false) {
    if (busy) return;
    const current = generation.current; setBusy(true); setNotice("");
    try { await api(start); }
    catch (error) { if (current === generation.current) setNotice(error instanceof Error ? error.message : "Операция не выполнена"); }
    finally { if (current === generation.current) setBusy(false); }
  }
  useEffect(() => {
    if (status?.job?.state !== "running") return;
    let cancelled = false;
    const timer = setTimeout(() => { if (!cancelled) void act(); }, 5000);
    return () => { cancelled = true; clearTimeout(timer); };
    // Each received status schedules one poll; the key stays only in page memory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const job = status?.job;
  return <main className="mx-auto max-w-6xl space-y-5 p-5 text-wd-text">
    <h1 className="text-2xl font-semibold">Замер скорости эмбеддингов DeepInfra</h1>
    <p>Временный тест: короткие синтетические вопросы по очереди отправляются в каждую модель тем же сетевым путём, что и поиск RAG. Данные пользователей не используются, записи в учёт затрат не создаются.</p>
    {notice && <p role="alert">{notice}</p>}
    {!status ? <form className="max-w-md space-y-3" onSubmit={event => { event.preventDefault(); void act(); }}>
      <label>Ключ администратора<input type="password" className={input} autoComplete="off" required value={secret} onChange={event => setSecret(event.target.value)} /></label>
      <p>Ключ хранится только в памяти страницы.</p><button className="wd-btn" disabled={busy}>Открыть замер</button>
    </form> : <>
      <div className="flex gap-3"><button className="wd-btn" disabled={busy} onClick={() => void act()}>Обновить результат</button>
        <button className="wd-btn" onClick={() => { generation.current++; setSecret(""); setStatus(null); setConfirmed(false); setNotice(""); setBusy(false); }}>Выйти</button></div>
      <section className="space-y-3 rounded-xl border border-wd-border p-4">
        <p>DeepInfra: {status.configured ? "настроен" : "нет ключа"}. Маршрут: {status.networkRoute}. Моделей: {status.models.length}. Таймаут запроса: {status.limits.requestTimeoutMs / 1000} с.</p>
        <label>Раундов (каждый — по одному запросу в каждую модель)<input type="number" className={input} min={status.limits.minRounds} max={status.limits.maxRounds}
          disabled={busy || job?.state === "running"} value={rounds} onChange={event => setRounds(Number(event.target.value))} /></label>
        <p>Около {rounds * status.models.length} запросов, примерно {Math.ceil(rounds * (status.models.length + 1) / 60)} мин. Стоимость — доли цента.</p>
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Запустить платный замер DeepInfra</label>
        <button className="wd-btn disabled:opacity-50" disabled={busy || !confirmed || !status.configured || job?.state === "running"} onClick={() => void act(true)}>Запустить замер</button>
      </section>
      {job && <section className="space-y-3 rounded-xl border border-wd-border p-4" aria-label="Результат замера">
        <p role="status">{job.state === "running" ? `Идёт: раунд ${job.completedRounds} из ${job.rounds}` : job.state === "finished" ? "Замер завершён" : "Замер прерван"}. Маршрут: {job.networkRoute}.</p>
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>
          {["Модель", "Отправлено", "Успешно", "429", "Таймаут", "Другие", "Разм.", "p10", "p50", "p90", "p95", "p99", "max", ">1 с", ">3 с", ">5 с"].map(head => <th key={head} className="p-1 text-left">{head}</th>)}
        </tr></thead><tbody>{job.results.map(row => <tr key={row.model} data-model={row.model}>
          <td className="p-1">{row.model}</td><td className="p-1">{row.sent}</td><td className="p-1">{row.ok}</td><td className="p-1">{row.http429}</td>
          <td className="p-1">{row.timeouts}</td><td className="p-1">{row.otherErrors}</td><td className="p-1">{row.dimensions ?? "—"}</td>
          <td className="p-1">{ms(row.p10)}</td><td className="p-1">{ms(row.p50)}</td><td className="p-1">{ms(row.p90)}</td><td className="p-1">{ms(row.p95)}</td>
          <td className="p-1">{ms(row.p99)}</td><td className="p-1">{ms(row.max)}</td><td className="p-1">{pct(row.pctOver1s)}</td>
          <td className="p-1">{pct(row.pctOver3s)}</td><td className="p-1">{pct(row.pctOver5s)}</td>
        </tr>)}</tbody></table></div>
        <p className="text-sm">Время в миллисекундах, по успешным ответам. Доли &gt;1/3/5 с считают сбои медленнее любого порога.</p>
        <details><summary>Технический отчёт (JSON)</summary><pre id="embedding-probe-json" className="overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify(job, null, 2)}</pre></details>
      </section>}
      <p className="text-sm">Результат хранится на сервере час после завершения или до перезапуска. Одновременно идёт один замер.</p>
    </>}
  </main>;
}
