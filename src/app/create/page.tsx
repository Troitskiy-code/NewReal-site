"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Footer from "@/components/Footer";
import CharacterForm, {
  EMPTY_CHARACTER_FORM,
  type CharacterFormValues,
} from "@/components/CharacterForm";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";
import { FaUser } from "react-icons/fa";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

async function uploadImage(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);
  const { data } = await axios.post("/api/upload", formData);
  return data.url;
}

export default function CreateCharacterPage() {
  const { status } = useSession();
  const router = useRouter();

  const [form, setForm] = useState<CharacterFormValues>(EMPTY_CHARACTER_FORM);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [loraFile, setLoraFile] = useState<File | null>(null);
  const [loraPreview, setLoraPreview] = useState<string | null>(null);
  const [generatedAvatarUrl, setGeneratedAvatarUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const updateField = <K extends keyof CharacterFormValues>(field: K, value: CharacterFormValues[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      toast.error("Максимальный размер изображения — 5 МБ");
      e.target.value = "";
      return;
    }
    setAvatarFile(file);
    setGeneratedAvatarUrl(null);
    setAvatarPreview(URL.createObjectURL(file));
  };

  const handleLoraChange = (file: File) => {
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      toast.error("Максимальный размер изображения — 5 МБ");
      return;
    }
    if (loraPreview?.startsWith("blob:")) URL.revokeObjectURL(loraPreview);
    setLoraFile(file);
    setLoraPreview(URL.createObjectURL(file));
  };

  const revokeBlobUrl = (url: string | null) => {
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
  };

  const handleClearDraft = () => {
    revokeBlobUrl(avatarPreview);
    revokeBlobUrl(loraPreview);
    setForm(EMPTY_CHARACTER_FORM);
    setAvatarFile(null);
    setAvatarPreview(null);
    setLoraFile(null);
    setLoraPreview(null);
    setGeneratedAvatarUrl(null);
    toast.success("Черновик очищен");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    reachGoal(METRIKA_GOALS.createCharacter);

    if (!form.name.trim()) {
      toast.error("Введите имя персонажа");
      return;
    }

    setSubmitting(true);
    const toastId = toast.loading("Создание персонажа...");

    try {
      let imageUrl: string | null = generatedAvatarUrl;
      let imageLora: string | null = null;

      if (!generatedAvatarUrl && avatarFile) imageUrl = await uploadImage(avatarFile);
      if (loraFile) imageLora = await uploadImage(loraFile);

      await axios.post("/api/characters", {
        name: form.name.trim(),
        appearance: form.appearance.trim() || null,
        description: form.description.trim() || null,
        greeting: form.greeting.trim() || null,
        scenario: form.scenario.trim() || null,
        exampleDialogs: form.exampleDialogs.trim() || null,
        descriptionCard: form.descriptionCard.trim() || null,
        avatarPrompt: form.avatarPrompt.trim() || null,
        tags: form.tags.trim() || null,
        imageUrl,
        imageLora,
        isPublic: form.isPublic,
      });

      toast.success("Персонаж создан!", { id: toastId });
      router.push("/gallery");
    } catch (err: unknown) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Не удалось создать персонажа";
      toast.error(message, { id: toastId });
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="min-h-dvh flex flex-col bg-wd-bg text-wd-text">
        <div className="flex-1 flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
        </div>
        <Footer />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="min-h-dvh flex flex-col bg-wd-bg text-wd-text">
        <Toaster position="top-right" />
        <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12 text-center">
          <FaUser className="text-4xl text-wd-primary opacity-30" />
          <h1 className="text-xl font-black uppercase tracking-tight">Создание персонажа</h1>
          <p className="max-w-sm text-xs text-wd-text-secondary">
            Войдите в аккаунт, чтобы создавать и сохранять персонажей.
          </p>
          <Link href="/login" className="wd-button px-6 py-2.5 text-sm">
            Войти
          </Link>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col overflow-hidden bg-[#121212] text-white select-none">
      <Toaster position="top-right" />
      <main className="flex w-full flex-1 flex-col overflow-y-auto px-2 py-6 scrollbar-subtle sm:px-4 md:py-8 lg:px-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 md:gap-8">
          <header className="space-y-1 border-b border-[#2A2A2A] pb-4 md:pb-5">
            <h1 className="text-xl font-bold text-white md:text-2xl">Создать персонажа</h1>
            <p className="text-sm text-[#A0A0A0]">
              Заполните профиль персонажа — внешность, поведение, сценарий и карточку.
            </p>
          </header>

          <form
            onSubmit={handleSubmit}
            className="w-full space-y-4 rounded-2xl border border-[#2A2A2A] bg-[#1A1A1A] p-4 text-base md:space-y-8 md:p-6"
          >
            <CharacterForm
              values={form}
              onChange={updateField}
              avatarPreview={avatarPreview}
              onAvatarChange={handleAvatarChange}
              onAvatarRemove={() => {
                setAvatarFile(null);
                setAvatarPreview(null);
                setGeneratedAvatarUrl(null);
              }}
              onAvatarGenerated={(url) => {
                setAvatarFile(null);
                setAvatarPreview(url);
                setGeneratedAvatarUrl(url);
              }}
              loraPreview={loraPreview}
              loraFile={loraFile}
              onLoraChange={handleLoraChange}
              onLoraRemove={() => {
                setLoraFile(null);
                setLoraPreview(null);
              }}
            />

            <div className="flex flex-col gap-4 border-t border-[#2A2A2A] pt-4 md:pt-6 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={handleClearDraft}
                className="self-start text-sm font-medium text-gray-400 transition-colors hover:text-white"
              >
                Очистить черновик
              </button>
              <div className="flex w-full flex-col gap-3 sm:ml-auto sm:w-auto sm:flex-row sm:gap-4 md:gap-6">
                <button
                  type="button"
                  onClick={() => router.back()}
                  className="w-full rounded-lg border border-gray-500 bg-transparent px-8 py-3 text-base font-bold text-gray-400 transition-colors hover:border-gray-400 hover:text-white sm:w-auto"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  id="character-create-submit"
                  data-metrika="character-create"
                  disabled={submitting}
                  className="w-full rounded-lg bg-[#6C63FF] px-8 py-3 text-base font-bold text-white transition-colors hover:bg-[#5a52e0] disabled:opacity-50 sm:w-auto"
                >
                  {submitting ? "Создание..." : "Создать"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </main>

      <Footer />
    </div>
  );
}
