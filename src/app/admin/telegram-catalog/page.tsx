"use client";
import { useRef, useState } from "react";
import LocaleLink from "@/components/LocaleLink";

// Owner's selection of characters visible in the Telegram Mini App. Everything not selected is
// hidden there (catalog, search, recommendations, direct links); the website is not affected.
type Row = { id: string; name: string; slug: string | null; tags: string | null; totalMessages: number; listed: boolean };
type Page = { total: number; listedTotal: number; page: number; pages: number; characters: Row[] };
const inputClass = "mt-1 w-full rounded-xl border border-wd-border bg-wd-bg p-3 text-wd-text";

export default function TelegramCatalogAdmin() {
  const [secret, setSecret] = useState("");
  const [data, setData] = useState<Page | null>(null);
  const [query, setQuery] = useState("");
  const [onlyListed, setOnlyListed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const session = useRef(0);

  async function load(page = 1, q = query, listed = onlyListed) {
    const current = session.current;
    setBusy(true); setNotice("");
    try {
      const params = new URLSearchParams({ page: String(page), q, filter: listed ? "listed" : "all" });
      const response = await fetch(`/api/admin/telegram-catalog?${params}`, { cache: "no-store", headers: { Authorization: `Bearer ${secret}` } });
      const result = await response.json().catch(() => ({ error: "Сервер временно недоступен" }));
      if (current !== session.current) return;
      if (!response.ok) throw new Error(result.error ?? "Не удалось загрузить список");
      setData(result);
    } catch (error) {
      if (current === session.current) setNotice(error instanceof Error ? error.message : "Не удалось загрузить список");
    } finally {
      if (current === session.current) setBusy(false);
    }
  }

  async function toggle(row: Row) {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/admin/telegram-catalog", {
        method: "POST", cache: "no-store",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: row.id, listed: !row.listed }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Не удалось сохранить");
      setData((prev) => prev && {
        ...prev,
        listedTotal: prev.listedTotal + (row.listed ? -1 : 1),
        characters: prev.characters.map((item) => item.id === row.id ? { ...item, listed: !row.listed } : item),
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return <main className="mx-auto max-w-4xl space-y-6 p-5 text-wd-text">
    <h1 className="text-2xl font-semibold">Каталог Telegram</h1>
    <p className="text-sm text-wd-text-secondary">В Mini App видны только отмеченные публичные персонажи (и собственные персонажи пользователя). Отметка не меняет сайт. Новые карточки в подборку не попадают, пока вы их не отметите.</p>
    {notice && <p role="alert" className="rounded-xl border border-wd-border p-3">{notice}</p>}
    {!data ? <form className="max-w-md space-y-3" onSubmit={(event) => { event.preventDefault(); void load(1); }}>
      <label className="block">Ключ администратора<input type="password" className={inputClass} autoComplete="off" required value={secret} onChange={(event) => setSecret(event.target.value)} /></label>
      <p className="text-sm">Войдите в свой аккаунт. Ключ хранится только в памяти страницы.</p>
      <button className="wd-btn" disabled={busy}>Открыть</button>
      <LocaleLink href="/login" className="ml-4 underline">Войти в аккаунт</LocaleLink>
    </form> : <>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void load(1); }}>
        <label className="block min-w-60 flex-1">Поиск по имени<input className={inputClass} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="flex items-center gap-2 pb-3 text-sm"><input type="checkbox" checked={onlyListed} onChange={(event) => { setOnlyListed(event.target.checked); void load(1, query, event.target.checked); }} /> Только в подборке</label>
        <button className="wd-btn" disabled={busy}>Найти</button>
        <button type="button" className="wd-btn" onClick={() => { session.current++; setSecret(""); setData(null); setNotice(""); setBusy(false); }}>Закрыть доступ</button>
      </form>
      <p className="text-sm">В подборке: <strong>{data.listedTotal}</strong>. Найдено публичных: {data.total}.</p>
      <ul className="divide-y divide-wd-border rounded-xl border border-wd-border">
        {data.characters.map((row) => <li key={row.id} className="flex items-center justify-between gap-3 p-3">
          <div className="min-w-0">
            <p className="truncate font-semibold">{row.name}</p>
            <p className="truncate text-xs text-wd-text-secondary">{row.tags || "—"} · сообщений: {row.totalMessages}{row.slug ? <> · <LocaleLink href={`/character/${row.slug}`} className="underline" target="_blank">открыть</LocaleLink></> : null}</p>
          </div>
          <button type="button" disabled={busy} onClick={() => void toggle(row)} aria-pressed={row.listed}
            className={`shrink-0 rounded-[50px] px-4 py-2 text-xs font-bold disabled:opacity-50 ${row.listed ? "bg-wd-secondary text-white" : "border border-wd-border text-white"}`}>
            {row.listed ? "В подборке" : "Добавить"}
          </button>
        </li>)}
      </ul>
      {data.pages > 1 && <div className="flex items-center gap-3 text-sm">
        <button type="button" className="wd-btn" disabled={busy || data.page <= 1} onClick={() => void load(data.page - 1)}>Назад</button>
        <span>{data.page} / {data.pages}</span>
        <button type="button" className="wd-btn" disabled={busy || data.page >= data.pages} onClick={() => void load(data.page + 1)}>Вперёд</button>
      </div>}
    </>}
  </main>;
}
