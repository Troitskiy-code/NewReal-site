"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import toast from "react-hot-toast";

type CoreMemory = {
  id: string;
  content: string;
  updatedAt: string;
};

type SummaryMemory = {
  summary: string;
  createdAt: string;
};

type MemoryPayload = {
  coreMemory: CoreMemory | null;
  summary: SummaryMemory | null;
};

const EMPTY_HINT = "Память пока пуста. Начните диалог, чтобы ИИ запомнил события.";

function resolveDraft(coreMemory: CoreMemory | null, summary: SummaryMemory | null): string {
  if (coreMemory?.content?.trim()) return coreMemory.content;
  if (summary?.summary?.trim()) return summary.summary;
  return "";
}

export default function MemoryEditor({
  characterId,
  onClose,
}: {
  characterId: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");

  const loadMemory = useCallback(async () => {
    const { data } = await axios.get<MemoryPayload>(`/api/chat/${characterId}/memory`);
    setDraft(resolveDraft(data.coreMemory, data.summary));
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

  const handleSave = async () => {
    setSaving(true);
    try {
      const { data } = await axios.put<{ coreMemory: CoreMemory }>(
        `/api/chat/${characterId}/memory/core`,
        { content: draft }
      );
      setDraft(data.coreMemory.content);
      console.log("[MemoryEditor] User updated memory.");
      toast.success("Память обновлена");
    } catch (error) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : null;
      toast.error(typeof message === "string" ? message : "Не удалось сохранить память");
    } finally {
      setSaving(false);
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
    <div className="flex min-h-[50vh] flex-col gap-3">
      <label htmlFor="memory-editor-text" className="sr-only">
        Память диалога
      </label>
      <textarea
        id="memory-editor-text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={EMPTY_HINT}
        disabled={saving}
        className="min-h-[40vh] w-full flex-1 resize-y rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3 text-sm leading-relaxed text-white outline-none placeholder:text-gray-500 focus:border-[#6C63FF] disabled:opacity-60"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-gray-500">{draft.length} символов</p>
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
            onClick={handleSave}
            disabled={saving}
            className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {saving ? "Сохранение..." : "Сохранить память"}
          </button>
        </div>
      </div>
    </div>
  );
}
