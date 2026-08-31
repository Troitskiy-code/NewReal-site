"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import toast from "react-hot-toast";
import { FaUser } from "react-icons/fa";
import type { ChatPersona } from "@/lib/persona";
import PersonaForm, { type PersonaFormValues } from "@/components/PersonaForm";

export default function PersonaSelector({
  characterId,
  selectedPersona,
  onChange,
}: {
  characterId: string;
  selectedPersona: ChatPersona | null;
  onChange: (persona: ChatPersona | null) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [personas, setPersonas] = useState<ChatPersona[]>([]);

  const loadPersonas = useCallback(async () => {
    const { data } = await axios.get<{ personas: ChatPersona[] }>(
      `/api/personas?characterId=${encodeURIComponent(characterId)}`
    );
    setPersonas(data.personas ?? []);
  }, [characterId]);

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      setLoading(true);
      try {
        await loadPersonas();
      } catch {
        if (!cancelled) toast.error("Не удалось загрузить личности");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [loadPersonas]);

  const handleSelect = async (persona: ChatPersona) => {
    setSaving(true);
    try {
      await axios.post(`/api/chat/${characterId}/persona`, { personaId: persona.id });
      onChange(persona);
      toast.success(`Личность «${persona.name}» выбрана`);
    } catch (error) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : null;
      toast.error(message || "Не удалось выбрать личность");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await axios.delete(`/api/chat/${characterId}/persona`);
      onChange(null);
      toast.success("Используется анонимная личность");
    } catch {
      toast.error("Не удалось сбросить личность");
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async (values: PersonaFormValues) => {
    setSaving(true);
    try {
      const { data } = await axios.post<{ persona: ChatPersona }>(
        "/api/personas",
        {
          ...values,
          characterId: values.isGlobal ? undefined : characterId,
        }
      );
      onChange(data.persona);
      setCreating(false);
      await loadPersonas();
      toast.success("Личность создана и применена к чату");
    } catch (error) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : null;
      toast.error(message || "Не удалось создать личность");
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
    <div className="space-y-5">
      <section className="rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3">
        <p className="mb-2 text-xs text-gray-500">Сейчас в этом чате</p>
        {selectedPersona ? (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#1A1A1A]">
              {selectedPersona.avatarUrl ? (
                <img
                  src={selectedPersona.avatarUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <FaUser className="text-gray-500" size={14} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">{selectedPersona.name}</p>
              <p className="line-clamp-2 text-xs text-gray-500">
                {selectedPersona.description || "Без описания"}
              </p>
            </div>
            <button
              type="button"
              onClick={handleReset}
              disabled={saving}
              className="shrink-0 text-xs text-gray-400 hover:text-white disabled:opacity-50"
            >
              Сбросить
            </button>
          </div>
        ) : (
          <p className="text-sm text-gray-400">Анонимная личность</p>
        )}
      </section>

      {creating ? (
        <section className="space-y-3">
          <h3 className="text-sm font-bold text-white">Новая личность</h3>
          <PersonaForm
            submitLabel="Создать и применить"
            submitting={saving}
            onSubmit={handleCreate}
            onCancel={() => setCreating(false)}
          />
        </section>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="w-full rounded-full border border-[#6C63FF]/40 bg-[#6C63FF]/10 px-4 py-2 text-sm font-semibold text-white hover:bg-[#6C63FF]/20"
        >
          Создать новую
        </button>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-bold text-white">Сохранённые личности</h3>
        {personas.length === 0 ? (
          <p className="text-sm text-gray-500">Пока нет сохранённых личностей для этого чата.</p>
        ) : (
          <ul className="space-y-2">
            {personas.map((persona) => {
              const active = selectedPersona?.id === persona.id;
              return (
                <li key={persona.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(persona)}
                    disabled={saving || active}
                    className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                      active
                        ? "border-[#6C63FF]/60 bg-[#6C63FF]/10"
                        : "border-[#2A2A2A] bg-[#0A0A0A] hover:border-[#6C63FF]/40"
                    } disabled:opacity-70`}
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#1A1A1A]">
                      {persona.avatarUrl ? (
                        <img src={persona.avatarUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <FaUser className="text-gray-500" size={14} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">{persona.name}</p>
                      <p className="line-clamp-2 text-xs text-gray-500">
                        {persona.description || "Без описания"}
                      </p>
                    </div>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-500">
                      {persona.isGlobal ? "Все чаты" : "Этот чат"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
