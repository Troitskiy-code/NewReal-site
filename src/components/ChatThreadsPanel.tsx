"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { LuArchive, LuArchiveRestore, LuCheck, LuPencil, LuPlus, LuTrash2, LuX } from "react-icons/lu";
import { showError, showSuccess } from "@/lib/toast";
import { threadDisplayTitle, type ChatThreadSummary } from "@/lib/chatThreadShared";
import { dateLocale } from "@/lib/i18nConfig";
import LoadErrorBlock from "@/components/LoadErrorBlock";

const TITLE_MAX = 80;

type Props = {
  characterId: string;
  currentThreadId: string | null;
  disabled?: boolean;
  creating?: boolean;
  onOpen: (thread: ChatThreadSummary) => void;
  onCreate: () => void;
  /** The open story was renamed, archived or restored. */
  onCurrentChanged: (thread: ChatThreadSummary) => void;
  /** The open story was deleted. */
  onCurrentDeleted: () => void;
};

function apiError(error: unknown, fallback: string): string {
  const message = axios.isAxiosError(error) ? error.response?.data?.error : null;
  return typeof message === "string" ? message : fallback;
}

/** Story list for one character: open, new, rename, archive/restore, delete with inline confirmation. */
export default function ChatThreadsPanel({
  characterId, currentThreadId, disabled = false, creating = false,
  onOpen, onCreate, onCurrentChanged, onCurrentDeleted,
}: Props) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const [threads, setThreads] = useState<ChatThreadSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback((signal?: AbortSignal) =>
    axios.get<{ threads: ChatThreadSummary[] }>(`/api/chat/${characterId}/threads`, { signal })
      .then(({ data }) => { setLoadError(false); setThreads(data.threads); })
      .catch((error) => { if (!axios.isCancel(error)) setLoadError(true); }),
  [characterId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const retry = () => {
    setLoadError(false);
    setThreads(null);
    void load();
  };

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus();
  }, [renamingId]);

  const replaceThread = (updated: ChatThreadSummary) => {
    setThreads((prev) => prev?.map((item) => (item.id === updated.id ? { ...item, ...updated, messageCount: item.messageCount } : item)) ?? prev);
    if (updated.id === currentThreadId) onCurrentChanged(updated);
  };

  const patch = async (thread: ChatThreadSummary, body: { title?: string | null; status?: "active" | "archived" }, success: string) => {
    setBusyId(thread.id);
    try {
      const { data } = await axios.patch<{ thread: ChatThreadSummary }>(`/api/chat/${characterId}/threads/${thread.id}`, body);
      replaceThread(data.thread);
      showSuccess(success);
      return true;
    } catch (error) {
      showError(apiError(error, t("chatThreads.updateFailed")));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const saveRename = async (thread: ChatThreadSummary) => {
    const title = draft.trim();
    if (title.length > TITLE_MAX) return;
    if (await patch(thread, { title: title || null }, t("chatThreads.renamed"))) setRenamingId(null);
  };

  const remove = async (thread: ChatThreadSummary) => {
    setBusyId(thread.id);
    try {
      await axios.delete(`/api/chat/${characterId}/threads/${thread.id}`, { data: { confirmed: true } });
      setThreads((prev) => prev?.filter((item) => item.id !== thread.id) ?? prev);
      setConfirmDeleteId(null);
      showSuccess(t("chatThreads.deletedToast"));
      if (thread.id === currentThreadId) onCurrentDeleted();
    } catch (error) {
      showError(apiError(error, t("chatThreads.deleteFailed")));
    } finally {
      setBusyId(null);
    }
  };

  // Escape first cancels an inline rename/confirmation; the dialog itself closes on the next Escape.
  const cancelInline = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || (!renamingId && !confirmDeleteId)) return;
    event.preventDefault();
    setRenamingId(null);
    setConfirmDeleteId(null);
  };

  const formatDate = (value: string) => new Date(value).toLocaleDateString(dateLocale(i18n.language), {
    day: "numeric", month: "short", year: "numeric",
  });

  const renderThread = (thread: ChatThreadSummary) => {
    const title = threadDisplayTitle(thread, t);
    const isCurrent = thread.id === currentThreadId;
    const busy = busyId === thread.id || disabled;
    const count = thread.messageCount ?? 0;
    return (
      <li key={thread.id} className={`rounded-xl border p-3 ${isCurrent ? "border-wd-primary/50 bg-wd-primary/10" : "border-wd-border bg-[#0c0b12]"}`}>
        {renamingId === thread.id ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => { event.preventDefault(); void saveRename(thread); }}
          >
            <label className="text-xs font-bold text-wd-text-secondary" htmlFor={`thread-title-${thread.id}`}>
              {t("chatThreads.renameLabel")}
            </label>
            <input
              id={`thread-title-${thread.id}`}
              ref={renameInputRef}
              value={draft}
              maxLength={TITLE_MAX}
              placeholder={t("chatThreads.renamePlaceholder")}
              onChange={(event) => setDraft(event.target.value)}
              className="w-full rounded-lg border border-wd-border bg-wd-bg px-3 py-2 text-sm text-white focus:border-wd-secondary focus:outline-none"
            />
            <div className="flex gap-2">
              <button type="submit" disabled={busy} className="wd-button inline-flex items-center gap-1 px-4 py-2 text-xs disabled:opacity-50">
                <LuCheck aria-hidden size={14} />{t("chatThreads.save")}
              </button>
              <button type="button" disabled={busy} onClick={() => setRenamingId(null)} className="px-3 py-2 text-xs text-wd-text-secondary hover:text-white">
                {t("chatThreads.cancel")}
              </button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => onOpen(thread)}
              disabled={disabled}
              aria-current={isCurrent ? "true" : undefined}
              aria-label={t("chatThreads.switchTo", { title })}
              className="flex min-w-0 flex-col items-start text-left disabled:opacity-60"
            >
              <span className="flex w-full items-center gap-2">
                <span className="truncate text-sm font-bold text-white">{title}</span>
                {isCurrent ? <span className="shrink-0 rounded-wd-pill bg-wd-primary/20 px-2 py-0.5 text-[10px] font-bold text-wd-primary-soft">{t("chatThreads.currentBadge")}</span> : null}
                {thread.status === "archived" ? <span className="shrink-0 rounded-wd-pill bg-white/10 px-2 py-0.5 text-[10px] text-wd-text-secondary">{t("chatThreads.archived")}</span> : null}
              </span>
              <span className="mt-0.5 text-[11px] text-wd-text-secondary">
                {count > 0 ? t("chatThreads.messages", { count }) : t("chatThreads.empty")}
                {" · "}
                {t("chatThreads.lastActivity", { date: formatDate(thread.lastMessageAt) })}
              </span>
            </button>
            {confirmDeleteId === thread.id ? (
              <div role="alertdialog" aria-labelledby={`thread-delete-${thread.id}`} className="rounded-lg border border-wd-primary/40 bg-wd-primary/10 p-3">
                <p id={`thread-delete-${thread.id}`} className="text-xs font-bold text-white">{t("chatThreads.deleteTitle", { title })}</p>
                <p className="mt-1 text-xs leading-relaxed text-wd-text-secondary">{t("chatThreads.deleteBody")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(thread)}
                    className="inline-flex items-center gap-1 rounded-wd-pill border border-wd-primary/40 bg-wd-primary/15 px-3 py-1.5 text-xs font-bold text-wd-primary-soft hover:bg-wd-primary/25 disabled:opacity-50"
                  >
                    <LuTrash2 aria-hidden size={13} />{t("chatThreads.deleteConfirm")}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirmDeleteId(null)} className="px-3 py-1.5 text-xs text-wd-text-secondary hover:text-white" autoFocus>
                    {t("chatThreads.cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                <button type="button" disabled={busy} onClick={() => { setRenamingId(thread.id); setDraft(thread.title ?? ""); setConfirmDeleteId(null); }}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-wd-text-secondary hover:bg-white/10 hover:text-white disabled:opacity-50">
                  <LuPencil aria-hidden size={12} />{t("chatThreads.rename")}
                </button>
                {thread.status === "archived" ? (
                  <button type="button" disabled={busy} onClick={() => void patch(thread, { status: "active" }, t("chatThreads.restoredToast"))}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-wd-text-secondary hover:bg-white/10 hover:text-white disabled:opacity-50">
                    <LuArchiveRestore aria-hidden size={12} />{t("chatThreads.restore")}
                  </button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => void patch(thread, { status: "archived" }, t("chatThreads.archivedToast"))}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-wd-text-secondary hover:bg-white/10 hover:text-white disabled:opacity-50">
                    <LuArchive aria-hidden size={12} />{t("chatThreads.archive")}
                  </button>
                )}
                <button type="button" disabled={busy} onClick={() => { setConfirmDeleteId(thread.id); setRenamingId(null); }}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-wd-primary-soft hover:bg-wd-primary/10 disabled:opacity-50">
                  <LuTrash2 aria-hidden size={12} />{t("chatThreads.delete")}
                </button>
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  if (loadError) return <LoadErrorBlock message={t("chatThreads.loadFailed")} onRetry={retry} />;
  if (!threads) {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1].map((key) => <div key={key} className="h-16 animate-pulse rounded-xl bg-white/10" />)}
      </div>
    );
  }

  const active = threads.filter((thread) => thread.status === "active");
  const archived = threads.filter((thread) => thread.status === "archived");
  return (
    <div className="flex flex-col gap-4" onKeyDown={cancelInline}>
      <div>
        <button
          type="button"
          onClick={onCreate}
          disabled={disabled || creating}
          className="wd-button inline-flex w-full items-center justify-center gap-2 py-2.5 text-sm disabled:opacity-50"
        >
          {creating ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : <LuPlus aria-hidden size={16} />}
          {t("chatThreads.newStory")}
        </button>
        <p className="mt-2 text-center text-[11px] leading-snug text-wd-text-secondary">{t("chatThreads.newStoryHint")}</p>
      </div>
      <section aria-labelledby={headingId}>
        <h3 id={headingId} className="mb-2 text-xs font-bold uppercase tracking-wider text-wd-text-secondary">{t("chatThreads.active")}</h3>
        {active.length ? <ul className="flex flex-col gap-2">{active.map(renderThread)}</ul>
          : <p className="text-xs text-wd-text-secondary">{t("chatThreads.noActive")}</p>}
      </section>
      {archived.length > 0 ? (
        <section>
          <button
            type="button"
            onClick={() => setShowArchived((value) => !value)}
            aria-expanded={showArchived}
            className="mb-2 inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider text-wd-text-secondary hover:text-white"
          >
            {showArchived ? <LuX aria-hidden size={12} /> : <LuArchive aria-hidden size={12} />}
            {t("chatThreads.archiveSection", { count: archived.length })}
          </button>
          {showArchived ? <ul className="flex flex-col gap-2">{archived.map(renderThread)}</ul> : null}
        </section>
      ) : null}
    </div>
  );
}
