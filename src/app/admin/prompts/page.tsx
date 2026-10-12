"use client";
import { useRef, useState } from "react";
import { ROLEPLAY_MODES, ROLEPLAY_MODE_LABELS, ROLEPLAY_STYLES, RP_FIELD_LIMITS, type RoleplayConfig } from "@/lib/roleplayConfig";

type CardRow = { id: string; name: string; version: number; mode: string; entryId: string | null; status: string; stale: boolean; valid: boolean; warnings: string[] };
type Status = { enabled: boolean; finalized: boolean; total: number; legacyCards: number; legacyStates: number; reviewed: number; applied: number };
type Draft = { description: string; appearance: string; greeting: string; scenario: string; exampleDialogs: string;
  roleplayMode: string; roleplayStyle: string; rpConfig: RoleplayConfig };
type Detail = { card: { id: string; name: string; systemPrompt: string | null; legacyPromptArchive: string | null } & Draft;
  fingerprint: string; stories: number; legacyStories: number; assessment: { warnings: string[] }; entry: { id: string; status: string; proposal: Draft | null } | null };
const textLabels = { description: "Характер персонажа / описание истории", appearance: "Внешность", greeting: "Первое сообщение", scenario: "Начальная ситуация", exampleDialogs: "Примеры диалога" };
const configLabels = { motivations: "Мотивы и цели", speechStyle: "Манера речи", relationships: "Отношения", world: "Мир и его устройство", narrativeRules: "Манера повествования", canonicalNotes: "Уточнения канона", npcs: "Действующие лица вселенной" };
const input = "w-full rounded-xl border border-wd-border bg-wd-bg p-3 text-wd-text";
const button = "wd-btn disabled:opacity-50";
export default function PromptMigrationAdmin() {
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [qualityConfirmed, setQualityConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const stop = useRef(false);
  function openDetail(result: Detail) {
    const fields = result.entry?.proposal ?? result.card;
    setDetail(result); setReviewConfirmed(false); setDraft({ description: fields.description ?? "", appearance: fields.appearance ?? "", greeting: fields.greeting ?? "", scenario: fields.scenario ?? "", exampleDialogs: fields.exampleDialogs ?? "", roleplayMode: fields.roleplayMode, roleplayStyle: fields.roleplayStyle, rpConfig: fields.rpConfig ?? {} });
  }
  async function api(query: string, body?: unknown) {
    const response = await fetch(`/api/admin/prompt-migration${query}`, { method: body ? "POST" : "GET", cache: "no-store",
      headers: { Authorization: `Bearer ${secret}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `Ошибка HTTP ${response.status}`);
    return result;
  }
  async function refresh(current: number) {
    const [nextStatus, page, nextDetail] = await Promise.all([api(""), api("?action=list"),
      detail ? api(`?action=detail&characterId=${encodeURIComponent(detail.card.id)}`) : Promise.resolve(null)]);
    if (current !== generation.current) return;
    setStatus(nextStatus); setCards(page.cards); setCursor(page.cursor); setSelected([]);
    if (nextDetail) openDetail(nextDetail);
  }
  async function run(work: (current: number) => Promise<void>) {
    if (busy) return;
    const current = generation.current;
    setBusy(true); setNotice(""); stop.current = false;
    try { await work(current); }
    catch (error) { if (current === generation.current) setNotice(error instanceof Error ? error.message : "Операция не выполнена"); }
    finally { if (current === generation.current) setBusy(false); }
  }
  function logout() {
    generation.current++; stop.current = true; setSecret(""); setStatus(null); setCards([]); setDetail(null); setDraft(null);
    setSelected([]); setCursor(null); setBackupConfirmed(false); setReviewConfirmed(false); setQualityConfirmed(false); setNotice(""); setBusy(false);
  }
  async function apply(entries: string[], current: number, action = "apply", fingerprint?: string) {
    const result = await api("", { action, entryIds: entries, confirmed: true, backupConfirmed,
      ...(fingerprint ? { storyReviewConfirmed: reviewConfirmed, fingerprints: { [entries[0]]: fingerprint } } : {}) });
    if (current !== generation.current) return false;
    const blocked = result.results.filter((row: { status: string }) => row.status === "blocked" || row.status === "failed");
    setNotice(blocked.length ? blocked.map((row: { error: string }) => row.error).join("; ") : "Пакет обработан. Переписка и память сохранены.");
    await refresh(current);
    return blocked.length === 0;
  }
  async function processQueue(current: number, action: "apply" | "stories") {
    let count = 0;
    while (!stop.current && current === generation.current) {
      const queue = await api(action === "stories" ? "?action=stories-queue" : "?action=queue");
      if (stop.current || current !== generation.current || !queue.entryIds.length) break;
      if (!await apply(queue.entryIds, current, action)) return;
      count += queue.entryIds.length; setNotice(`Обработано карточек: ${count}.`);
    }
    if (current === generation.current) setNotice(`Обработка ${stop.current ? "остановлена после текущего пакета" : "завершена"}. Обработано карточек: ${count}.`);
  }
  const currentEntry = detail?.entry;
  return <main className="mx-auto max-w-6xl space-y-5 p-5 text-wd-text">
    <h1 className="text-2xl font-semibold">Переход персонажей на новые инструкции</h1>
    <a className="underline" href="/admin/chat-diagnostics">Диагностика ответов DeepInfra</a>
    <p>Сначала сравните старый промпт с полями карточки. Проверка сохраняет черновик перевода, а не меняет персонажа. Платные генерации не запускаются.</p>
    {notice && <p role="status" aria-live="polite" className="rounded-xl border border-wd-border p-3">{notice}</p>}
    {!status ? <form className="max-w-md space-y-3" onSubmit={event => { event.preventDefault(); void run(refresh); }}>
      <label>Ключ администратора<input className={input} type="password" autoComplete="off" required value={secret} onChange={event => setSecret(event.target.value)} /></label>
      <p className="text-sm text-wd-text-secondary">Ключ хранится только в памяти этой страницы.</p><button className={button} disabled={busy}>Открыть проверку</button>
    </form> : <>
      <div className="flex flex-wrap gap-3"><button className={button} disabled={busy} onClick={() => void run(refresh)}>Обновить</button><button className={button} onClick={logout}>Выйти</button></div>
      <section className="space-y-3 rounded-xl border border-wd-border p-4">
        <p>Всего карточек: {status.total}. На v1: {status.legacyCards}. Настроек историй v1: {status.legacyStates}. Проверено к переводу: {status.reviewed}. Переведено инструментом: {status.applied}.</p>
        {!status.enabled && <p>Для применения оператору нужно включить RP_PROMPT_V2_ENABLED=true. Проверять карточки можно заранее.</p>}
        <label className="flex gap-2"><input type="checkbox" checked={backupConfirmed} disabled={busy} onChange={event => setBackupConfirmed(event.target.checked)} />Свежий бэкап базы создан</label>
        <div className="flex flex-wrap gap-3">
          <button className={button} disabled={busy || !status.enabled || !backupConfirmed || selected.length === 0} onClick={() => void run(current => apply(selected, current).then(() => {}))}>Перевести выбранные (до 5)</button>
          <button className={button} disabled={busy || !status.enabled || !backupConfirmed || !status.reviewed} onClick={() => void run(current => processQueue(current, "apply"))}>Перевести все проверенные</button>
          <button className={button} disabled={busy || !status.enabled || !backupConfirmed || !status.legacyStates || !status.applied} onClick={() => void run(current => processQueue(current, "stories"))}>Согласовать оставшиеся истории v1</button>
          {busy && <button className={button} onClick={() => { stop.current = true; }}>Остановить после пакета</button>}
        </div>
      </section>
      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        <section aria-label="Карточки" className="space-y-2">{cards.map(card => <div key={card.id} className="rounded-xl border border-wd-border p-3">
          <button className="block w-full text-left font-semibold" disabled={busy} onClick={() => void run(async current => {
            const result: Detail = await api(`?action=detail&characterId=${encodeURIComponent(card.id)}`);
            if (current !== generation.current) return;
            openDetail(result);
          })}>{card.name}</button>
          <p className="text-sm">v{card.version} · {card.status === "applied" ? "Переведён" : card.status === "reviewed" ? card.stale ? "Проверка устарела" : "Проверен" : "Не проверен"}</p>
          {card.status === "reviewed" && !card.stale && card.entryId && <label className="flex gap-2"><input type="checkbox" disabled={busy || (!selected.includes(card.entryId) && selected.length >= 5)} checked={selected.includes(card.entryId)} onChange={event => setSelected(previous => event.target.checked ? [...previous, card.entryId!] : previous.filter(id => id !== card.entryId))} />В пробный пакет</label>}
        </div>)}{cursor && <button className={button} disabled={busy} onClick={() => void run(async current => {
          const page = await api(`?action=list&cursor=${encodeURIComponent(cursor)}`);
          if (current !== generation.current) return; setCards(previous => [...previous, ...page.cards]); setCursor(page.cursor);
        })}>Следующие карточки</button>}</section>
        {detail && draft ? <section className="space-y-4" aria-label="Проверка карточки">
          <h2 className="text-xl font-semibold">{detail.card.name}</h2><p>Сохранённых настроек историй: {detail.stories}, из них v1: {detail.legacyStories}. Тип проверенной карточки станет типом переводимых историй v1. Истории, уже работающие на v2, сохранят свой выбранный тип.</p>
          {detail.assessment.warnings.map(text => <p key={text} className="text-amber-300">{text}</p>)}
          <label className="block">Старый промпт (только чтение)<textarea readOnly className={input} rows={9} value={detail.card.legacyPromptArchive ?? detail.card.systemPrompt ?? ""} /></label>
          <fieldset disabled={busy || currentEntry?.status === "applied"} className="space-y-3">
            <label className="block">Тип карточки<select className={input} value={draft.roleplayMode} onChange={event => setDraft({ ...draft, roleplayMode: event.target.value })}>{ROLEPLAY_MODES.map(mode => <option key={mode} value={mode}>{ROLEPLAY_MODE_LABELS[mode]}</option>)}</select></label>
            <label className="block">Стиль<select className={input} value={draft.roleplayStyle} onChange={event => setDraft({ ...draft, roleplayStyle: event.target.value })}>{ROLEPLAY_STYLES.map(style => <option key={style} value={style}>{style === "mixed" ? "Смешанный RP" : style === "dialogue" ? "Диалог" : "Повествование"}</option>)}</select></label>
            {(Object.keys(textLabels) as (keyof typeof textLabels)[]).map(field => <label key={field} className="block">{textLabels[field]}<textarea className={input} rows={3} value={draft[field]} onChange={event => setDraft({ ...draft, [field]: event.target.value })} /></label>)}
            <details><summary>Дополнительные сведения из старого промпта</summary>{(Object.keys(configLabels) as (keyof typeof configLabels)[]).map(field => <label key={field} className="my-3 block">{configLabels[field]}<textarea className={input} rows={3} maxLength={RP_FIELD_LIMITS[field]} value={draft.rpConfig[field] ?? ""} onChange={event => setDraft({ ...draft, rpConfig: { ...draft.rpConfig, [field]: event.target.value } })} /></label>)}</details>
            {draft.roleplayMode === "group" && <section className="space-y-3"><h3>Участники: {draft.rpConfig.participants?.length ?? 0} / 8</h3>
              {(draft.rpConfig.participants ?? []).map((member, index) => <fieldset key={member.id} className="space-y-2 rounded-xl border border-wd-border p-3"><legend>Участник {index + 1}</legend>{(["name", "description", "appearance", "speechStyle"] as const).map(field => <label key={field} className="block">{field === "name" ? "Имя" : field === "description" ? "Характер" : field === "appearance" ? "Внешность" : "Манера речи"}<textarea className={input} rows={2} value={member[field]} onChange={event => setDraft({ ...draft, rpConfig: { ...draft.rpConfig, participants: draft.rpConfig.participants!.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: event.target.value } : item) } })} /></label>)}</fieldset>)}
              <button type="button" className={button} disabled={(draft.rpConfig.participants?.length ?? 0) >= 8} onClick={() => setDraft({ ...draft, rpConfig: { ...draft.rpConfig, participants: [...(draft.rpConfig.participants ?? []), { id: crypto.randomUUID(), name: "", description: "", appearance: "", speechStyle: "" }] } })}>Добавить участника</button>
            </section>}
            <label className="flex gap-2"><input type="checkbox" checked={reviewConfirmed} onChange={event => setReviewConfirmed(event.target.checked)} />Сравнил старый промпт, перенёс необходимые особенности и подтвердил тип истории</label>
            <button className={button} disabled={!reviewConfirmed} onClick={() => void run(async current => {
              await api("", { action: "review", characterId: detail.card.id, fingerprint: detail.fingerprint, fields: draft, confirmed: true });
              if (current !== generation.current) return;
              setReviewConfirmed(false); await refresh(current); setNotice("Проверка сохранена. Карточка и истории ещё не изменены.");
            })}>Сохранить проверку</button>
          </fieldset>
          {currentEntry?.status === "applied" && <div className="space-y-3">
            <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={reviewConfirmed} onChange={event => setReviewConfirmed(event.target.checked)} />Проверил актуальные поля и тип этой карточки перед согласованием историй</label>
            <button className={button} disabled={busy || !backupConfirmed || !reviewConfirmed || !status.enabled || detail.legacyStories === 0} onClick={() => void run(current => apply([currentEntry.id], current, "stories", detail.fingerprint).then(() => {}))}>Согласовать истории этой карточки</button>
            <button className={button} disabled={busy || !backupConfirmed} onClick={() => void run(current => apply([currentEntry.id], current, "rollback").then(() => {}))}>Откатить перевод этой карточки</button>
          </div>}
        </section> : <p>Выберите карточку для сравнения и подготовки перевода.</p>}
      </div>
      <section className="space-y-3 rounded-xl border border-wd-border p-4"><h2 className="text-xl font-semibold">Завершение перехода</h2>
        <p>После завершения переключатели версий исчезнут из редактора и чата. Откат останется в этой панели.</p>
        <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={qualityConfirmed} onChange={event => setQualityConfirmed(event.target.checked)} />Пробные ответы новой сборки проверены, качество принято</label>
        <button className={button} disabled={busy || !qualityConfirmed || !status.enabled || status.legacyCards > 0 || status.legacyStates > 0 || status.finalized} onClick={() => void run(async current => { await api("", { action: "finalize", confirmed: true, qualityConfirmed }); await refresh(current); setNotice("Общий переход завершён."); })}>{status.finalized ? "Переход завершён" : "Завершить переход"}</button>
      </section>
    </>}
  </main>;
}
