"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import toast from "react-hot-toast";

type CoreMemory = {
  id: string;
  content: string;
  updatedAt: string;
};

type EpisodicMemory = {
  id: string;
  event: string;
  timestamp: string;
  importance: number;
};

type SummaryMemory = {
  summary: string;
  createdAt: string;
};

type MemoryPayload = {
  coreMemory: CoreMemory | null;
  episodicMemories: EpisodicMemory[];
  summary: SummaryMemory | null;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MemoryEditor({ characterId }: { characterId: string }) {
  const [loading, setLoading] = useState(true);
  const [savingCore, setSavingCore] = useState(false);
  const [refreshingSummary, setRefreshingSummary] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingCore, setEditingCore] = useState(false);
  const [coreDraft, setCoreDraft] = useState("");
  const [coreMemory, setCoreMemory] = useState<CoreMemory | null>(null);
  const [episodicMemories, setEpisodicMemories] = useState<EpisodicMemory[]>([]);
  const [summary, setSummary] = useState<SummaryMemory | null>(null);

  const loadMemory = useCallback(async () => {
    const { data } = await axios.get<MemoryPayload>(`/api/chat/${characterId}/memory`);
    setCoreMemory(data.coreMemory);
    setCoreDraft(data.coreMemory?.content ?? "");
    setEpisodicMemories(data.episodicMemories ?? []);
    setSummary(data.summary);
    setEditingCore(false);
  }, [characterId]);

  useEffect(() => {
    let cancelled = false;

    const fetchMemory = async () => {
      setLoading(true);
      try {
        await loadMemory();
      } catch {
        if (!cancelled) {
          toast.error("Не удалось загрузить память");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchMemory();
    return () => {
      cancelled = true;
    };
  }, [loadMemory]);

  const handleSaveCore = async () => {
    setSavingCore(true);
    try {
      const { data } = await axios.put<{ coreMemory: CoreMemory }>(
        `/api/chat/${characterId}/memory/core`,
        { content: coreDraft }
      );
      setCoreMemory(data.coreMemory);
      setCoreDraft(data.coreMemory.content);
      setEditingCore(false);
      toast.success("Ключевая память сохранена");
    } catch {
      toast.error("Не удалось сохранить ключевую память");
    } finally {
      setSavingCore(false);
    }
  };

  const handleDeleteEpisodic = async (episodicId: string) => {
    if (!window.confirm("Удалить это событие из памяти?")) return;

    setDeletingId(episodicId);
    try {
      await axios.delete(`/api/chat/${characterId}/memory/episodic/${episodicId}`);
      setEpisodicMemories((prev) => prev.filter((item) => item.id !== episodicId));
      toast.success("Событие удалено");
    } catch {
      toast.error("Не удалось удалить событие");
    } finally {
      setDeletingId(null);
    }
  };

  const handleRefreshSummary = async () => {
    setRefreshingSummary(true);
    try {
      const { data } = await axios.post<{ summary: SummaryMemory }>(
        `/api/chat/${characterId}/memory/refresh-summary`
      );
      setSummary(data.summary);
      toast.success("Суммаризация обновлена");
    } catch (error) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : null;
      toast.error(message || "Не удалось обновить суммаризацию");
    } finally {
      setRefreshingSummary(false);
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
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-white">Ключевая память</h3>
          {!editingCore && (
            <button
              type="button"
              onClick={() => {
                setCoreDraft(coreMemory?.content ?? "");
                setEditingCore(true);
              }}
              className="rounded-full px-3 py-1 text-xs font-semibold text-[#6C63FF] hover:bg-white/5"
            >
              Редактировать
            </button>
          )}
        </div>

        {editingCore ? (
          <div className="space-y-2">
            <textarea
              value={coreDraft}
              onChange={(event) => setCoreDraft(event.target.value)}
              rows={6}
              className="w-full resize-y rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3 text-sm text-white outline-none focus:border-[#6C63FF]"
              placeholder="Что ИИ должен помнить о персонаже и диалоге"
              disabled={savingCore}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCoreDraft(coreMemory?.content ?? "");
                  setEditingCore(false);
                }}
                disabled={savingCore}
                className="rounded-full px-3 py-1 text-xs text-gray-400 hover:text-gray-300 disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleSaveCore}
                disabled={savingCore}
                className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {savingCore ? "Сохранение..." : "Сохранить"}
              </button>
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3 text-sm leading-relaxed text-gray-300">
            {coreMemory?.content?.trim() || "Пока нет ключевой памяти."}
          </p>
        )}

        {coreMemory?.updatedAt && (
          <p className="text-xs text-gray-500">Обновлено: {formatDate(coreMemory.updatedAt)}</p>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-bold text-white">События диалога</h3>
        {episodicMemories.length === 0 ? (
          <p className="text-sm text-gray-500">Пока нет сохранённых событий.</p>
        ) : (
          <ul className="space-y-2">
            {episodicMemories.map((item) => (
              <li
                key={item.id}
                className="rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <span className="text-xs text-gray-500">{formatDate(item.timestamp)}</span>
                  <button
                    type="button"
                    onClick={() => handleDeleteEpisodic(item.id)}
                    disabled={deletingId === item.id}
                    className="shrink-0 rounded-full px-2 py-0.5 text-xs text-red-400 hover:bg-white/5 disabled:opacity-50"
                  >
                    {deletingId === item.id ? "Удаление..." : "Удалить"}
                  </button>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-300">
                  {item.event}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-white">Суммаризация</h3>
          <button
            type="button"
            onClick={handleRefreshSummary}
            disabled={refreshingSummary}
            className="rounded-full px-3 py-1 text-xs font-semibold text-[#6C63FF] hover:bg-white/5 disabled:opacity-50"
          >
            {refreshingSummary ? "Обновление..." : "Обновить"}
          </button>
        </div>
        <p className="whitespace-pre-wrap rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3 text-sm leading-relaxed text-gray-300">
          {summary?.summary?.trim() || "Суммаризация ещё не создана."}
        </p>
        {summary?.createdAt && (
          <p className="text-xs text-gray-500">Создано: {formatDate(summary.createdAt)}</p>
        )}
      </section>
    </div>
  );
}
