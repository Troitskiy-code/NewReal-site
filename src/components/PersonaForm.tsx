"use client";

import { useEffect, useState, type FormEvent } from "react";
import axios from "axios";
import toast from "react-hot-toast";
import { FaUser } from "react-icons/fa";
import {
  PERSONA_DESCRIPTION_MAX,
  PERSONA_NAME_MAX,
  type ChatPersona,
} from "@/lib/persona";

const INPUT_CLASS =
  "w-full rounded-lg border border-[#2A2A2A] bg-[#0A0A0A] p-3 text-sm text-white outline-none transition-colors placeholder:text-gray-400 focus:border-[#6C63FF]";

export type PersonaFormValues = {
  name: string;
  description: string;
  avatarUrl: string | null;
  isGlobal: boolean;
};

export const EMPTY_PERSONA_FORM: PersonaFormValues = {
  name: "",
  description: "",
  avatarUrl: null,
  isGlobal: false,
};

function toFormValues(persona?: ChatPersona | null): PersonaFormValues {
  if (!persona) return { ...EMPTY_PERSONA_FORM };
  return {
    name: persona.name,
    description: persona.description ?? "",
    avatarUrl: persona.avatarUrl,
    isGlobal: persona.isGlobal,
  };
}

export default function PersonaForm({
  persona,
  submitLabel,
  submitting,
  onSubmit,
  onCancel,
}: {
  persona?: ChatPersona | null;
  submitLabel: string;
  submitting?: boolean;
  onSubmit: (values: PersonaFormValues) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<PersonaFormValues>(() => toFormValues(persona));
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setForm(toFormValues(persona));
  }, [persona]);

  const handleAvatarChange = async (file: File | null) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Максимальный размер файла — 5 МБ");
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const { data } = await axios.post<{ url: string }>("/api/upload", formData);
      setForm((current) => ({ ...current, avatarUrl: data.url }));
    } catch {
      toast.error("Не удалось загрузить аватар");
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) {
      toast.error("Укажите имя личности");
      return;
    }
    await onSubmit({
      ...form,
      name: form.name.trim(),
      description: form.description.trim(),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#2A2A2A] bg-[#0A0A0A]">
          {form.avatarUrl ? (
            <img src={form.avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <FaUser className="text-gray-500" />
          )}
        </div>
        <label className="cursor-pointer text-xs font-semibold text-[#6C63FF] hover:underline">
          {uploading ? "Загрузка..." : "Загрузить аватар"}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={uploading || submitting}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = "";
              void handleAvatarChange(file);
            }}
          />
        </label>
        {form.avatarUrl && (
          <button
            type="button"
            onClick={() => setForm((current) => ({ ...current, avatarUrl: null }))}
            className="text-xs text-gray-500 hover:text-gray-300"
            disabled={submitting}
          >
            Убрать
          </button>
        )}
      </div>

      <div>
        <label className="mb-1 block text-xs text-gray-400">Имя</label>
        <input
          type="text"
          value={form.name}
          maxLength={PERSONA_NAME_MAX}
          onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          className={INPUT_CLASS}
          placeholder="Как к вам обращаться"
          disabled={submitting}
          required
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-gray-400">
          Описание ({form.description.length}/{PERSONA_DESCRIPTION_MAX})
        </label>
        <textarea
          value={form.description}
          maxLength={PERSONA_DESCRIPTION_MAX}
          onChange={(event) =>
            setForm((current) => ({ ...current, description: event.target.value }))
          }
          rows={4}
          className={INPUT_CLASS}
          placeholder="Кто вы в этой истории, характер, привычки"
          disabled={submitting}
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-300">
        <input
          type="checkbox"
          checked={form.isGlobal}
          onChange={(event) =>
            setForm((current) => ({ ...current, isGlobal: event.target.checked }))
          }
          className="accent-[#6C63FF]"
          disabled={submitting}
        />
        Сохранить для всех чатов
      </label>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-full px-3 py-1.5 text-xs text-gray-400 hover:text-gray-300 disabled:opacity-50"
          >
            Отмена
          </button>
        )}
        <button
          type="submit"
          disabled={submitting || uploading || !form.name.trim()}
          className="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {submitting ? "Сохранение..." : submitLabel}
        </button>
      </div>
    </form>
  );
}
