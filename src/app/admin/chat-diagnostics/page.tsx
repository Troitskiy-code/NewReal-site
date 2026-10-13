"use client";
import { useEffect, useRef, useState } from "react";
import type { AdminDiagnosticJob } from "@/lib/adminChatDiagnostic";

type Status = { configured: boolean; traceEnabled: boolean; pipelineRoute: "direct" | "proxy"; selectedNetworkRoute?: "direct" | "proxy" | "allvpn"; nodeVersion: string; cooldownRemainingMs: number; job: AdminDiagnosticJob | null };
const routeLabel = (route: string) => route === "allvpn" ? "через AllVPN" : route === "proxy" ? "через основной HTTPS-прокси" : "напрямую";
const models = [
  { name: "deepinfra:mistralai/Mistral-Small-3.2-24B-Instruct-2506", label: "Mistral Small 3.2" },
  { name: "deepinfra:Qwen/Qwen3-235B-A22B-Instruct-2507", label: "Qwen 3 235B" },
];
const outcomes: Record<string, string> = { completed: "Ответ завершён", failed: "Сбой", cancelled: "Прерван", pending: "Ожидание" };
const observations: Record<string, string> = {
  failure_not_reproduced: "Оба обращения завершились. Сбой в этом тесте не воспроизвёлся.",
  investigate_provider_and_server_connection: "Оба обращения завершились сбоем. Проверить DeepInfra и соединение сервера.",
  investigate_app_limits_and_processing: "Прямое обращение завершилось, путь приложения — со сбоем. Сравнить паузы с таймаутами и этап отказа.",
  variable_provider_or_connection: "Результаты различаются. Возможна переменная нагрузка провайдера или нестабильное соединение.",
  diagnostic_unavailable: "Тест не удалось завершить. Проверьте настройки и серверные логи.",
};
const input = "w-full rounded-xl border border-wd-border bg-wd-bg p-3 text-wd-text";
export default function ChatDiagnosticsAdmin() {
  const [secret, setSecret] = useState(""), [status, setStatus] = useState<Status | null>(null);
  const [model, setModel] = useState(models[0].name), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const generation = useRef(0);
  async function api(start = false) {
    const current = generation.current;
    const response = await fetch("/api/admin/chat-diagnostics", { method: start ? "POST" : "GET", cache: "no-store",
      headers: { Authorization: `Bearer ${secret}`, ...(start ? { "Content-Type": "application/json" } : {}) },
      ...(start ? { body: JSON.stringify({ model, confirmed }) } : {}) });
    const result = await response.json().catch(() => ({ error: `Сервер временно недоступен (HTTP ${response.status}). Обновите результат после перезапуска.` }));
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
    if (!status || status.job?.state !== "running" && status.cooldownRemainingMs <= 0) return;
    let cancelled = false;
    const timer = setTimeout(() => { if (!cancelled) void act(); }, 3000);
    return () => { cancelled = true; clearTimeout(timer); };
    // Each received status schedules one poll; no overlapping requests or stored credential.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const job = status?.job;
  return <main className="mx-auto max-w-4xl space-y-5 p-5 text-wd-text">
    <h1 className="text-2xl font-semibold">Диагностика ответов</h1>
    <p>Сравнение двух обращений с сервера: напрямую к DeepInfra и через обработку ответа приложения. Используется одинаковый искусственный диалог.</p>
    {notice && <p role="alert">{notice}</p>}
    {!status ? <form className="max-w-md space-y-3" onSubmit={event => { event.preventDefault(); void act(); }}>
      <label>Ключ администратора<input type="password" className={input} autoComplete="off" required value={secret} onChange={event => setSecret(event.target.value)} /></label>
      <p>Ключ хранится только в памяти страницы.</p><button className="wd-btn" disabled={busy}>Открыть диагностику</button>
    </form> : <>
      <div className="flex gap-3"><button className="wd-btn" disabled={busy} onClick={() => void act()}>Обновить результат</button>
        <button className="wd-btn" onClick={() => { generation.current++; setSecret(""); setStatus(null); setConfirmed(false); setNotice(""); setBusy(false); }}>Выйти</button></div>
      <section className="space-y-3 rounded-xl border border-wd-border p-4">
        <p>DeepInfra: {status.configured ? "настроен" : "проверьте настройки"}. Подробная трассировка: {status.traceEnabled ? "включена" : "выключена"}.</p>
        <p>Маршрут приложения: {routeLabel(status.selectedNetworkRoute ?? status.pipelineRoute)}. Контрольное обращение всегда идёт напрямую.</p>
        <label>Модель<select className={input} disabled={busy || job?.state === "running"} value={model} onChange={event => setModel(event.target.value)}>{models.map(item => <option key={item.name} value={item.name}>{item.label}</option>)}</select></label>
        <p>Один тест делает до трёх обращений. DeepInfra может списать оплату за генерации. Сообщения, память и VC пользователей не меняются.</p>
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Запустить один тест с оплатой обращений DeepInfra</label>
        <button className="wd-btn disabled:opacity-50" disabled={busy || !confirmed || !status.configured || job?.state === "running" || status.cooldownRemainingMs > 0} onClick={() => void act(true)}>Запустить сравнение</button>
        {status.cooldownRemainingMs > 0 && <p>Следующий тест доступен через {Math.ceil(status.cooldownRemainingMs / 1000)} с.</p>}
      </section>
      {job && <section className="space-y-3 rounded-xl border border-wd-border p-4" aria-label="Результат сравнения">
        <h2 className="text-xl font-semibold">{models.find(item => item.name === job.model)?.label}</h2>
        <p>Маршрут этого теста: {routeLabel(job.selectedNetworkRoute ?? job.pipelineRoute)}.</p>
        <p role="status">{job.state === "running" ? `Тест идёт: ${job.phase === "direct" ? "прямое обращение" : "обработка приложения"}. Можно закрыть страницу и открыть результат позже.` : observations[job.observation ?? "diagnostic_unavailable"]}</p>
        {job.direct && <p>Напрямую: {outcomes[String(job.direct.outcome)] ?? "Сбой"}. Время: {Number(job.direct.durationMs) / 1000} с. HTTP: {String(job.direct.status ?? "не получен")}. Максимальная пауза: {Number(job.direct.maxChunkGapMs) / 1000} с.</p>}
        {job.pipeline && <p>Через приложение: {outcomes[job.pipeline.outcome] ?? "Сбой"}. Время: {job.pipeline.durationMs / 1000} с. Попыток: {job.pipeline.attempts.length}.</p>}
        <p>Это независимые запросы. Тест не проверяет отправку ответа через браузер, прокси сайта и сохранение в базе. Один прогон не доказывает причину прежних ошибок.</p>
        <details><summary>Технический отчёт</summary><pre className="overflow-x-auto whitespace-pre-wrap text-sm">{JSON.stringify({ nodeVersion: status.nodeVersion, ...job }, null, 2)}</pre></details>
      </section>}
      <p className="text-sm">Результат хранится на сервере 15 минут после завершения, до следующего теста или перезапуска. Одновременно выполняется один тест на процесс сервера.</p>
    </>}
  </main>;
}
