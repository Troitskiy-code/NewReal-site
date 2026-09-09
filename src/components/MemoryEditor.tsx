"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import toast from "react-hot-toast";

type TabId = "summary" | "core" | "episodic";

type CoreMemory = {
  id: string;
  content: string;
  updatedAt: string;
};

type SummaryMemory = {
  summary: string;
  createdAt: string;
};

type EpisodicItem = {
  id: string;
  event: string;
  timestamp: string;
  importance: number;
};

type MemoryPayload = {
  summary: SummaryMemory | null;
  core: CoreMemory | null;
  coreMemory?: CoreMemory | null;
  episodic: EpisodicItem[];
  episodicMemories?: EpisodicItem[];
};

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "summary", label: "Суммаризация" },
  { id: "core", label: "Постоянная память" },
  { id: "episodic", label: "События" },
];

function formatEventDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function apiError(error: unknown, fallback: string): string {
  const message = axios.isAxiosError(error) ? error.response?.data?.error : null;
  return typeof message === "string" ? message : fallback;
}

export default function MemoryEditor({
  characterId,
  onClose,
}: {
  characterId: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabId>("summary");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [coreDraft, setCoreDraft] = useState("");
  const [events, setEvents] = useState<EpisodicItem[]>([]);
  const [addingEvent, setAddingEvent] = useState(false);
  const [newEvent, setNewEvent] = useState("");
  const [newImportance, setNewImportance] = useState(3);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadMemory = useCallback(async () => {
    const { data } = await axios.get<MemoryPayload>(`/api/chat/${characterId}/memory`);
    setSummaryDraft(data.summary?.summary ?? "");
    setCoreDraft(data.core?.content ?? data.coreMemory?.content ?? "");
    setEvents(data.episodic ?? data.episodicMemories ?? []);
  }, [characterId]);

  useEffect(() => {
    let cancelled = false;

    const fetchMemory = async () => {
      setLoading(true);
      try {
        await loadMemory();
      } catch {
        if (!cancelled) toast.error("Не удалось загрузить память");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchMemory();
    return () => {
      cancelled = true;
    };
  }, [loadMemory]);

  const handleSaveSummary = async () => {
    setSaving(true);
    try {
      const { data } = await axios.put<{ summary: SummaryMemory | null }>(
        `/api/chat/${characterId}/memory/summary`,
        { summary: summaryDraft }
      );
      setSummaryDraft(data.summary?.summary ?? "");
      console.log("[MemoryEditor] summary saved");
      toast.success("Суммаризация сохранена");
    } catch (error) {
      toast.error(apiError(error, "Не удалось сохранить суммаризацию"));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCore = async () => {
    setSaving(true);
    try {
      const { data } = await axios.put<{ coreMemory: CoreMemory; core?: CoreMemory }>(
        `/api/chat/${characterId}/memory/core`,
        { content: coreDraft }
      );
      setCoreDraft(data.core?.content ?? data.coreMemory.content);
      console.log("[MemoryEditor] core saved");
      toast.success("Постоянная память сохранена");
    } catch (error) {
      toast.error(apiError(error, "Не удалось сохранить постоянную память"));
    } finally {
      setSaving(false);
    }
  };

  const handleAddEvent = async () => {
    if (!newEvent.trim()) {
      toast.error("Введите текст события");
      return;
    }

    setSaving(true);
    try {
      const { data } = await axios.post<{ episodic: EpisodicItem }>(
        `/api/chat/${characterId}/memory/episodic`,
        { event: newEvent, importance: newImportance }
      );
      setEvents((prev) => [data.episodic, ...prev]);
      setNewEvent("");
      setAddingEvent(false);
      console.log("[MemoryEditor] episodic added");
      toast.success("Событие добавлено");
    } catch (error) {
      toast.error(apiError(error, "Не удалось добавить событие"));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteEvent = async (episodicId: string) => {
    setDeletingId(episodicId);
    try {
      await axios.delete(`/api/chat/${characterId}/memory/episodic/${episodicId}`);
      setEvents((prev) => prev.filter((item) => item.id !== episodicId));
      console.log("[MemoryEditor] episodic deleted");
      toast.success("Событие удалено");
    } catch (error) {
      toast.error(apiError(error, "Не удалось удалить событие"));
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[50vh] flex-col gap-4">
      <div className="flex gap-1 rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-1">
        {TABS.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`flex-1 rounded-md px-2 py-2 text-[11px] font-bold uppercase tracking-wide transition-colors sm:text-xs ${
                active ? "bg-[#6C63FF] text-white" : "text-gray-400 hover:text-white"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === "summary" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <textarea
            id="memory-summary"
            value={summaryDraft}
            onChange={(event) => setSummaryDraft(event.target.value)}
            placeholder="Краткая выжимка диалога, появляется при длительных диалогах для сохранения качества памяти"
            disabled={saving}
            className="min-h-[32vh] w-full flex-1 resize-y rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3 text-sm leading-relaxed text-white outline-none placeholder:text-gray-500 focus:border-[#6C63FF] disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-gray-500">{summaryDraft.length} символов</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="rounded-full px-4 py-2 text-sm text-gray-400 hover:text-gray-300 disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleSaveSummary}
                disabled={saving}
                className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {saving ? "Сохранение..." : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "core" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <textarea
            id="memory-core"
            value={coreDraft}
            onChange={(event) => setCoreDraft(event.target.value)}
            placeholder="Устойчивые факты о персонаже и отношениях."
            disabled={saving}
            className="min-h-[32vh] w-full flex-1 resize-y rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3 text-sm leading-relaxed text-white outline-none placeholder:text-gray-500 focus:border-[#6C63FF] disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-gray-500">{coreDraft.length} символов</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="rounded-full px-4 py-2 text-sm text-gray-400 hover:text-gray-300 disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleSaveCore}
                disabled={saving}
                className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {saving ? "Сохранение..." : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "episodic" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {addingEvent ? (
            <div className="space-y-2 rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3">
              <textarea
                value={newEvent}
                onChange={(event) => setNewEvent(event.target.value)}
                placeholder="Что произошло?"
                disabled={saving}
                className="min-h-[96px] w-full resize-y rounded-lg border border-[#2A2A2A] bg-[#121212] p-2 text-sm text-white outline-none placeholder:text-gray-500 focus:border-[#6C63FF] disabled:opacity-60"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-gray-400">
                  Важность
                  <select
                    value={newImportance}
                    onChange={(event) => setNewImportance(Number(event.target.value))}
                    disabled={saving}
                    className="rounded-md border border-[#2A2A2A] bg-[#121212] px-2 py-1 text-white"
                  >
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={4}>4</option>
                    <option value={5}>5</option>
                  </select>
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAddingEvent(false);
                      setNewEvent("");
                    }}
                    disabled={saving}
                    className="rounded-full px-3 py-1.5 text-sm text-gray-400 hover:text-gray-300 disabled:opacity-50"
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={handleAddEvent}
                    disabled={saving}
                    className="rounded-full bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
                  >
                    {saving ? "Сохранение..." : "Сохранить"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingEvent(true)}
              className="rounded-full border border-[#2A2A2A] px-4 py-2 text-sm font-semibold text-white transition-colors hover:border-[#6C63FF]"
            >
              Добавить событие
            </button>
          )}

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
            {events.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-500">
                Важных событий пока нет.
              </p>
            ) : (
              events.map((item) => (
                <article
                  key={item.id}
                  className="rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3"
                >
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">
                      {formatEventDate(item.timestamp)}
                      {" · "}
                      важность {item.importance}
                    </p>
                    <button
                      type="button"
                      onClick={() => handleDeleteEvent(item.id)}
                      disabled={deletingId === item.id}
                      className="shrink-0 text-xs font-semibold text-red-400 hover:text-red-300 disabled:opacity-50"
                    >
                      {deletingId === item.id ? "Удаление..." : "Удалить"}
                    </button>
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-200">
                    {item.event}
                  </p>
                </article>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
