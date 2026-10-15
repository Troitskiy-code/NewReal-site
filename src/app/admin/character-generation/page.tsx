"use client";
import { useEffect, useRef, useState } from "react";
import LocaleLink from "@/components/LocaleLink";

type Item = { id: string; themeKey: string; name: string; state: string; stage: string; inProgress: boolean;
  characterId: string | null; isPublic: boolean; error: string | null; canRetry: boolean; canRepair: boolean; providerTaskId: string | null;
  warnings?: string[] };
type Batch = { id: string; state: string; budgetRub: number; spentRub: number; reservedRub: number; createdAt: string; items: Item[] };
type Status = { configured: boolean; missing: string[]; workerEnabled: boolean;
  themes: Array<{ key: string; name: string; theme: string; novelty: string }>; batches: Batch[] };
const inputClass = "mt-1 w-full rounded-xl border border-wd-border bg-wd-bg p-3 text-wd-text";
const stages: Record<string, string> = { text: "Создание карточки", text_repair: "Пересоздание карточки", review: "Проверка согласованности", review_repair: "Проверка новой карточки", image_submit: "Запуск аватара", image_poll: "Ожидание аватара", translate: "Перевод на английский", save: "Сохранение персонажа" };
const states: Record<string, string> = { running: "Партия выполняется", paused: "Приостановлена", attention: "Нужно проверить результаты", completed: "Партия завершена" };
const money = (value: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(value);

export default function CharacterGenerationAdmin() {
  const [secret, setSecret] = useState(""), [status, setStatus] = useState<Status | null>(null);
  const [count, setCount] = useState(10), [budget, setBudget] = useState(200), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""), [taskIds, setTaskIds] = useState<Record<string, string>>({});
  const startKey = useRef<string | null>(null), session = useRef(0);
  async function request(body?: Record<string, unknown>) {
    const current = session.current;
    const response = await fetch("/api/admin/character-generation", { method: body ? "POST" : "GET", cache: "no-store",
      headers: { Authorization: `Bearer ${secret}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json().catch(() => ({ error: "Сервер временно недоступен" }));
    if (current !== session.current) return;
    if (!response.ok) throw new Error(result.error ?? "Не удалось обновить партию");
    setStatus(result);
  }
  async function act(body?: Record<string, unknown>) {
    if (busy) return;
    const current = session.current; setBusy(true); setNotice("");
    try { await request(body); }
    catch (error) { if (current === session.current) setNotice(error instanceof Error ? error.message : "Операция не выполнена"); }
    finally { if (current === session.current) setBusy(false); }
  }
  async function start() {
    startKey.current ??= crypto.randomUUID();
    await act({ action: "start", clientKey: startKey.current, count, budgetRub: budget });
  }
  useEffect(() => {
    if (!status?.batches.some(batch => batch.state === "running")) return;
    const timer = setTimeout(() => { if (!busy) void act(); }, 5000);
    return () => clearTimeout(timer);
    // Schedule one read after each response; refreshing the page never starts paid work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, busy]);
  const active = status?.batches.some(batch => batch.state === "running" || batch.state === "paused");
  return <main className="mx-auto max-w-5xl space-y-6 p-5 text-wd-text">
    <h1 className="text-2xl font-semibold">Генерация персонажей</h1>
    <p>Полные карточки, аватары и английский перевод. Персонажи сохраняются черновиками; их можно проверить в обычном редакторе и опубликовать.</p>
    {notice && <p role="alert" className="rounded-xl border border-wd-border p-3">{notice}</p>}
    {!status ? <form className="max-w-md space-y-3" onSubmit={event => { event.preventDefault(); void act(); }}>
      <label className="block">Ключ администратора<input type="password" className={inputClass} autoComplete="off" required value={secret} onChange={event => setSecret(event.target.value)} /></label>
      <p className="text-sm">Войдите в свой аккаунт. Ключ хранится только в памяти страницы.</p>
      <button className="wd-btn" disabled={busy}>Открыть генератор</button>
      <LocaleLink href="/login" className="ml-4 underline">Войти в аккаунт</LocaleLink>
    </form> : <>
      <div className="flex flex-wrap gap-3"><button className="wd-btn" disabled={busy} onClick={() => void act()}>Обновить</button>
        <button className="wd-btn" onClick={() => { session.current++; setSecret(""); setStatus(null); setNotice(""); setBusy(false); }}>Закрыть доступ</button></div>
      {!status.configured && <p role="alert">Для запуска настройте: {status.missing.join(", ")}.</p>}
      {!status.workerEnabled && <p role="alert">Фоновый обработчик выключен. Настройте его на сервере перед запуском.</p>}
      <section className="space-y-4 rounded-xl border border-wd-border p-4">
        <h2 className="text-xl font-semibold">Новая партия</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label>Количество персонажей<input type="number" className={inputClass} min={1} max={10} value={count} disabled={busy || Boolean(active)} onChange={event => { startKey.current = null; setCount(Number(event.target.value)); }} /></label>
          <label>Предел расходов, ₽<input type="number" className={inputClass} min={1} max={200} step={1} value={budget} disabled={busy || Boolean(active)} onChange={event => { startKey.current = null; setBudget(Number(event.target.value)); }} /></label>
        </div>
        <p className="text-sm">В предел входят тексты, переводы, аватары и повторные попытки. Оплата неподтверждённых запросов учитывается с запасом. Последующее хранение файлов оплачивается отдельно.</p>
        <button className="wd-btn disabled:opacity-50" disabled={busy || Boolean(active) || !status.configured || !status.workerEnabled}
          onClick={() => void start()}>Создать партию</button>
        {status.batches.length > 0 && !active && <button className="ml-3 underline" onClick={() => { startKey.current = null; setNotice("Можно запустить новую партию. Имена и похожие карточки будут проверены повторно."); }}>Подготовить новую партию</button>}
        <details><summary>Темы следующей партии (свободно {status.themes.length}) и отличия от каталога</summary><ol className="mt-3 space-y-3">{status.themes.slice(0, count).map(theme => <li key={theme.key}><strong>{theme.name}: {theme.theme}</strong><p className="text-sm">{theme.novelty}</p></li>)}</ol></details>
      </section>
      {status.batches.map(batch => <section key={batch.id} className="space-y-4" aria-label="Партия персонажей">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-wd-border pb-3">
          <div><h2 className="text-xl font-semibold">{states[batch.state] ?? batch.state}</h2>
            <p>{batch.items.filter(item => item.state === "ready").length} из {batch.items.length} готовы · учтено {money(batch.spentRub)} · зарезервировано {money(batch.reservedRub)} · предел {money(batch.budgetRub)}</p>
            <p className="text-sm">{new Date(batch.createdAt).toLocaleString("ru-RU")}. Можно закрыть страницу: задания сохранены на сервере.</p></div>
          {batch.state === "running" && <button className="wd-btn" disabled={busy} onClick={() => void act({ action: "pause", batchId: batch.id })}>Приостановить</button>}
          {batch.state === "paused" && <button className="wd-btn" disabled={busy} onClick={() => void act({ action: "resume", batchId: batch.id })}>Продолжить</button>}
        </div>
        <ul className="divide-y divide-wd-border">{batch.items.map(item => <li key={item.id} className="space-y-2 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{item.name}</h3>
            <span>{item.state === "ready" ? item.isPublic ? "Опубликован" : "Черновик готов" : item.state === "failed" || item.state === "uncertain" ? "Нужна проверка" : `${stages[item.stage] ?? "Ожидание"}${item.inProgress ? "…" : ""}`}</span></div>
          {item.characterId && <div className="flex gap-4"><LocaleLink className="underline" href={`/edit/${item.characterId}`}>Открыть в редакторе</LocaleLink>
            {!item.isPublic && <button disabled={busy} className="underline" onClick={() => void act({ action: "publish", batchId: batch.id, itemId: item.id })}>Опубликовать</button>}</div>}
          {item.error && <p className="text-sm" role="status">{item.error}</p>}
          {item.warnings?.length ? <details className="text-sm"><summary>Проверьте английский перевод ({item.warnings.length})</summary>
            <ul className="mt-1 list-disc pl-5">{item.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details> : null}
          {item.canRetry && <button className="wd-btn" disabled={busy} onClick={() => void act({ action: "retry", batchId: batch.id, itemId: item.id })}>Повторить незавершённый этап</button>}
          {item.canRepair && <div><button className="wd-btn" disabled={busy} onClick={() => void act({ action: "repair", batchId: batch.id, itemId: item.id })}>Пересоздать карточку</button>
            <p className="mt-1 text-sm">Одна дополнительная попытка исправления с резервной моделью, до двух запросов текста. Расходы входят в прежний предел партии.</p></div>}
          {item.state === "uncertain" && <form className="flex max-w-xl gap-2" onSubmit={event => { event.preventDefault(); void act({ action: "recover", batchId: batch.id, itemId: item.id, taskId: taskIds[item.id] }); }}>
            <label className="flex-1">ID задания из истории Kie<input className={inputClass} value={taskIds[item.id] ?? ""} onChange={event => setTaskIds(current => ({ ...current, [item.id]: event.target.value }))} required /></label>
            <button className="wd-btn self-end" disabled={busy}>Проверить задание</button></form>}
        </li>)}</ul>
      </section>)}
    </>}
  </main>;
}
