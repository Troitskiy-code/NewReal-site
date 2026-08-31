"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import toast from "react-hot-toast";
import { FaEdit, FaGlobe, FaPlus, FaTrash, FaUser } from "react-icons/fa";
import type { ChatPersona } from "@/lib/persona";
import PersonaForm, { type PersonaFormValues } from "@/components/PersonaForm";

export default function PersonaManager() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [personas, setPersonas] = useState<ChatPersona[]>([]);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadPersonas = useCallback(async () => {
    const { data } = await axios.get<{ personas: ChatPersona[] }>("/api/personas");
    setPersonas(data.personas ?? []);
  }, []);

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

  const handleCreate = async (values: PersonaFormValues) => {
    setSaving(true);
    try {
      await axios.post("/api/personas", values);
      setCreating(false);
      await loadPersonas();
      toast.success("Личность создана");
    } catch (error) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : null;
      toast.error(message || "Не удалось создать личность");
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (personaId: string, values: PersonaFormValues) => {
    setSaving(true);
    try {
      await axios.put(`/api/personas/${personaId}`, values);
      setEditingId(null);
      await loadPersonas();
      toast.success("Личность обновлена");
    } catch (error) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : null;
      toast.error(message || "Не удалось сохранить личность");
    } finally {
      setSaving(false);
    }
  };

  const handleMakeGlobal = async (persona: ChatPersona) => {
    setSaving(true);
    try {
      await axios.put(`/api/personas/${persona.id}`, {
        name: persona.name,
        description: persona.description,
        avatarUrl: persona.avatarUrl,
        isGlobal: true,
      });
      await loadPersonas();
      toast.success("Личность доступна во всех чатах");
    } catch {
      toast.error("Не удалось сделать личность глобальной");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (persona: ChatPersona) => {
    if (!window.confirm(`Удалить личность «${persona.name}»? Она отвяжется от всех чатов.`)) {
      return;
    }

    setDeletingId(persona.id);
    try {
      await axios.delete(`/api/personas/${persona.id}`);
      setPersonas((prev) => prev.filter((item) => item.id !== persona.id));
      toast.success("Личность удалена");
    } catch {
      toast.error("Не удалось удалить личность");
    } finally {
      setDeletingId(null);
    }
  };

  const editingPersona = personas.find((item) => item.id === editingId) ?? null;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-black uppercase tracking-wide text-white">Мои личности</h2>
        {!loading && (
          <span className="text-xs text-wd-text-secondary">{personas.length} шт.</span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
        </div>
      ) : (
        <>
          {creating ? (
            <div className="wd-card space-y-3 p-4">
              <h3 className="text-sm font-bold text-white">Новая личность</h3>
              <PersonaForm
                submitLabel="Создать"
                submitting={saving}
                onSubmit={handleCreate}
                onCancel={() => setCreating(false)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setCreating(true);
              }}
              className="wd-button inline-flex items-center gap-2 px-5 py-2.5 text-xs"
            >
              <FaPlus className="text-[10px]" />
              Создать новую
            </button>
          )}

          {personas.length === 0 && !creating ? (
            <div className="wd-card space-y-3 p-8 text-center">
              <FaUser className="mx-auto text-3xl opacity-20" />
              <p className="text-sm text-wd-text-secondary">
                Личности ещё нет. Создайте её, чтобы ИИ знал, кем вы являетесь в диалоге.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {personas.map((persona) => (
                <article key={persona.id} className="wd-card flex flex-col gap-3 p-4">
                  {editingId === persona.id ? (
                    <PersonaForm
                      persona={editingPersona}
                      submitLabel="Сохранить"
                      submitting={saving}
                      onSubmit={(values) => handleUpdate(persona.id, values)}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <>
                      <div className="flex items-start gap-3">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-wd-border bg-[#0A0A0A]">
                          {persona.avatarUrl ? (
                            <img
                              src={persona.avatarUrl}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <FaUser className="text-gray-500" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-sm font-extrabold text-white">
                            {persona.name}
                          </h3>
                          <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-wd-text-secondary">
                            {persona.description || "Без описания"}
                          </p>
                          <p className="mt-2 text-[10px] uppercase tracking-wide text-wd-text-secondary">
                            {persona.isGlobal ? "Для всех чатов" : "Только для одного чата"}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 border-t border-wd-border pt-3">
                        <button
                          type="button"
                          onClick={() => {
                            setCreating(false);
                            setEditingId(persona.id);
                          }}
                          className="flex-1 rounded-[50px] border border-wd-border bg-[#0A0A0A] py-2 text-[10px] font-bold text-white hover:border-[#6C63FF]"
                        >
                          <span className="inline-flex items-center justify-center gap-1.5">
                            <FaEdit className="text-[9px]" />
                            Редактировать
                          </span>
                        </button>
                        {!persona.isGlobal && (
                          <button
                            type="button"
                            onClick={() => handleMakeGlobal(persona)}
                            disabled={saving}
                            className="flex-1 rounded-[50px] border border-[#6C63FF]/30 bg-[#6C63FF]/10 py-2 text-[10px] font-bold text-white hover:bg-[#6C63FF]/20 disabled:opacity-50"
                          >
                            <span className="inline-flex items-center justify-center gap-1.5">
                              <FaGlobe className="text-[9px]" />
                              Сделать глобальной
                            </span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDelete(persona)}
                          disabled={deletingId === persona.id}
                          className="flex-1 rounded-[50px] border border-wd-primary/30 bg-wd-primary/10 py-2 text-[10px] font-bold text-wd-primary disabled:opacity-50"
                        >
                          <span className="inline-flex items-center justify-center gap-1.5">
                            <FaTrash className="text-[9px]" />
                            Удалить
                          </span>
                        </button>
                      </div>
                    </>
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
