'use client';
import { useRef, useState } from 'react';

type Reply = { id: string; message: string; status: string; createdAt: string; attempts?: number; nextAttemptAt?: string | null; providerId?: string | null };
type Ticket = { id: string; email: string; topic: string; status: string; createdAt: string; message?: string; replies?: Reply[] };
type ReplyAvailability = { ready: boolean; message?: string };
type MigrationStatus = { migration: string; ready: boolean; canApply: boolean; mode?: 'prisma' | 'schema_only'; message: string };
const states: Record<string, string> = { pending: 'В очереди', sending: 'Отправляется', failed: 'Ожидает повторной попытки', dead: 'Нужна проверка оператором', accepted: 'Принято Resend', open: 'Новое', answered: 'Ответ отправлен' };

export default function SupportAdmin() {
  const [secret, setSecret] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [replyAvailability, setReplyAvailability] = useState<ReplyAvailability>({ ready: false });
  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus | null>(null);
  const [confirmMigration, setConfirmMigration] = useState(false);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const draft = useRef<{ ticketId: string; message: string; clientKey: string } | null>(null);
  async function api(path = '', body?: unknown) {
    const response = await fetch(`/api/admin/support${path}`, { method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { Authorization: `Bearer ${secret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`Не удалось прочитать ответ сервера (HTTP ${response.status}). Повторите запрос после обновления страницы.`); }
    if (!response.ok) throw new Error(result.error || 'Ошибка запроса');
    return result;
  }
  async function run(action: (current: number) => Promise<void>) {
    if (busy) return;
    const current = generation.current;
    setBusy(true); setNotice('');
    try { await action(current); } catch (error) {
      if (current === generation.current) setNotice(error instanceof Error ? error.message : 'Ошибка');
    } finally { if (current === generation.current) setBusy(false); }
  }
  async function list(current: number, more = false) {
    const result = await api(more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
    if (current !== generation.current) return;
    setTickets(previous => more ? [...previous, ...result.tickets] : result.tickets); setCursor(result.cursor); setLoggedIn(true);
  }
  async function select(id: string, current: number, resetDraft = true) {
    const result = await api(`?ticketId=${encodeURIComponent(id)}`);
    if (current !== generation.current) return;
    setTicket(result.ticket); setReplyAvailability(result.replyAvailability ?? { ready: true });
    if (resetDraft) { setMessage(''); draft.current = null; }
  }
  function showDelivery(result: { reply: Reply; delivery: { message: string } }, current: number) {
    if (current !== generation.current) return;
    setTicket(previous => previous ? { ...previous,
      status: result.reply.status === 'accepted' ? 'answered' : previous.status,
      replies: [...(previous.replies ?? []).filter(row => row.id !== result.reply.id), result.reply]
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    } : previous);
    setNotice(result.delivery.message);
  }
  function logout() {
    generation.current++; setSecret(''); setLoggedIn(false); setTickets([]); setTicket(null);
    setReplyAvailability({ ready: false });
    setMigrationStatus(null); setConfirmMigration(false);
    setMessage(''); setSearch(''); setNotice(''); setBusy(false); draft.current = null;
  }
  const button = 'rounded-xl bg-violet-600 px-4 py-2 text-white disabled:opacity-50';
  const input = 'w-full rounded-xl border border-white/20 bg-black/20 p-3';
  return <main className="mx-auto max-w-5xl space-y-5 p-5 text-white">
    <h1 className="text-2xl font-semibold">Поддержка NewVerse</h1>
    {notice && <p role="status" aria-live="polite" className="rounded-xl border border-white/20 p-3">{notice}</p>}
    {!loggedIn ? <form className="max-w-md space-y-3" onSubmit={event => { event.preventDefault(); void run(current => list(current)); }}>
      <label className="block">Ключ администратора (ADMIN_SECRET)<input className={input} type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} required /></label>
      <p className="text-sm text-white/60">Ключ действует только в этой вкладке и не сохраняется в браузере.</p>
      <button className={button} disabled={busy}>Открыть обращения</button>
    </form> : <>
      <div className="flex flex-wrap gap-3"><button className={button} disabled={busy} onClick={() => void run(current => list(current))}>Обновить список</button><button className={button} onClick={logout}>Выйти</button></div>
      <section aria-label="Проверка базы поддержки" className="space-y-3 rounded-xl border border-white/20 p-4">
        <button className={button} disabled={busy} onClick={() => void run(async current => {
          const result = await api('/migration');
          if (current !== generation.current) return;
          setMigrationStatus(result); setConfirmMigration(false);
        })}>Проверить миграцию</button>
        {migrationStatus && <>
          <p role="status">{migrationStatus.message}</p>
          {migrationStatus.canApply && <>
            <p className="text-sm text-white/60">{migrationStatus.mode === 'schema_only'
              ? 'Будет создана только таблица ответов и её индексы. Существующие обращения сохраняются.'
              : 'Применяется только миграция ответов поддержки. Существующие обращения сохраняются.'}</p>
            <label className="flex items-start gap-2"><input type="checkbox" checked={confirmMigration} disabled={busy} onChange={event => setConfirmMigration(event.target.checked)} />{migrationStatus.mode === 'schema_only'
              ? 'Подтверждаю создание таблицы ответов' : 'Подтверждаю применение миграции ответов поддержки'}</label>
            <button className={button} disabled={busy || !confirmMigration} onClick={() => void run(async current => {
              if (!confirmMigration || !migrationStatus.canApply) return;
              const result = await api('/migration', { action: 'apply', migration: migrationStatus.migration });
              if (current !== generation.current) return;
              setMigrationStatus(result); setConfirmMigration(false);
              if (ticket) await select(ticket.id, current);
            })}>{migrationStatus.mode === 'schema_only' ? 'Создать таблицу ответов' : 'Применить миграцию'}</button>
          </>}
        </>}
      </section>
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void run(current => select(search.trim(), current)); }}>
        <label className="flex-1">Номер тикета<input className={input} value={search} onChange={event => setSearch(event.target.value)} required /></label>
        <button className={button} disabled={busy}>Найти</button>
      </form>
      <div className="grid gap-5 md:grid-cols-[280px_1fr]">
        <section aria-label="Обращения" className="space-y-2">{tickets.map(row => <button key={row.id} disabled={busy} onClick={() => void run(current => select(row.id, current))} className="block w-full break-words rounded-xl border border-white/20 p-3 text-left">
          <strong>{row.id}</strong><p>{row.email}</p><p>{row.topic} · {states[row.status] || row.status}</p>
        </button>)}{cursor && <button className={button} disabled={busy} onClick={() => void run(current => list(current, true))}>Ещё обращения</button>}</section>
        {ticket && <section className="space-y-4">
          <h2 className="font-semibold">{ticket.id} · {ticket.email}</h2><p className="whitespace-pre-wrap break-words">{ticket.message}</p>
          {!replyAvailability.ready && <p role="alert" className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-amber-100">{replyAvailability.message}</p>}
          {ticket.replies?.map(reply => <article key={reply.id} className="space-y-2 rounded-xl border border-white/20 p-3">
            <p className="whitespace-pre-wrap break-words">{reply.message}</p>
            <p className="text-sm text-white/60">{states[reply.status] || reply.status} · {new Date(reply.createdAt).toLocaleString('ru')} · Попыток: {reply.attempts ?? 0}</p>
            {reply.providerId && <p className="break-all text-sm text-white/60">ID письма Resend: {reply.providerId}</p>}
            {reply.status === 'failed' && reply.nextAttemptAt && <p className="text-sm text-amber-100">Следующая попытка не раньше {new Date(reply.nextAttemptAt).toLocaleString('ru')}</p>}
            {['pending', 'failed'].includes(reply.status) && <button className={button} disabled={busy} onClick={() => void run(async current => {
              const result = await api('', { action: 'deliver', replyId: reply.id });
              showDelivery(result, current);
            })}>Отправить сохранённый ответ</button>}
          </article>)}
          <button className={button} disabled={busy} onClick={() => void run(current => select(ticket.id, current, false))}>Обновить статус ответа</button>
          <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(async current => {
            if (!replyAvailability.ready) return;
            const text = message.trim();
            if (!draft.current || draft.current.ticketId !== ticket.id || draft.current.message !== text) draft.current = { ticketId: ticket.id, message: text, clientKey: crypto.randomUUID() };
            const result = await api('', draft.current);
            showDelivery(result, current);
            if (current === generation.current) { setMessage(''); draft.current = null; }
          }); }}>
            <label className="block">Ответ пользователю<textarea className={input} rows={7} maxLength={10000} value={message} onChange={event => setMessage(event.target.value)} disabled={!replyAvailability.ready} required /></label>
            <p className="text-sm text-white/60">Отправитель — адрес поддержки @newvers.ai. Получатель — email этого тикета. Входящие ответы на письма пока не подключены.</p>
            <p className="text-sm text-white/60">Отправка начинается сразу и может занять до 10 секунд. При сбое ответ сохраняется для повторной попытки.</p>
            <button className={button} disabled={busy || !replyAvailability.ready || !message.trim()}>Отправить ответ</button>
          </form>
        </section>}
      </div>
    </>}
  </main>;
}
