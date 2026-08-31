"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Footer from "@/components/Footer";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";
import {
  FaUser,
  FaEdit,
  FaTrash,
  FaPlus,
  FaImages,
  FaComments,
  FaEnvelope,
  FaRobot,
  FaCrown,
} from "react-icons/fa";
import FavoriteButton from "@/components/FavoriteButton";
import PersonaManager from "@/components/PersonaManager";
import VerseCoinsBalance from "@/components/VerseCoinsBalance";
import { getCardDescription } from "@/lib/characterFields";

type Character = {
  id: string;
  name: string;
  description: string | null;
  appearance: string | null;
  tags: string | null;
  imageUrl: string | null;
  isPublic: boolean;
  createdAt: string;
  isFavorited?: boolean;
};

type CharactersResponse = {
  data: Character[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
};

type UserStats = {
  charactersCount: number;
  chatsCount: number;
  messagesCount: number;
  createdAt: string;
};

type SubscriptionBalance = {
  subscriptionLabel: string | null;
  subscriptionActive: boolean;
  subscriptionEnd: string | null;
  daysRemaining: number;
  pendingSubscriptionLabel: string | null;
  pendingSubscriptionEnd: string | null;
  recurringEnabled?: boolean;
  recurringSetupRequired?: boolean;
};

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  return tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function getInitials(name?: string | null, email?: string | null): string {
  const source = (name || email || "U").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function formatRegistrationDate(value?: string | Date | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function ProfilePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "authenticated" || !session?.user?.id) {
      setLoading(false);
      return;
    }

    const fetchProfileData = async () => {
      setLoading(true);
      setStatsLoading(true);
      setError(null);

      try {
        const [charactersRes, statsRes, balanceRes] = await Promise.all([
          axios.get<CharactersResponse>(`/api/characters?userId=${session.user.id}&limit=100`),
          axios.get<UserStats>("/api/user/stats"),
          axios.get<SubscriptionBalance>("/api/user/balance"),
        ]);
        setCharacters(charactersRes.data.data);
        setStats(statsRes.data);
        setSubscription(balanceRes.data);
      } catch (err) {
        const message =
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : "Не удалось загрузить профиль";
        setError(message);
        setCharacters([]);
        setStats(null);
        setSubscription(null);
      } finally {
        setLoading(false);
        setStatsLoading(false);
      }
    };

    fetchProfileData();
  }, [session?.user?.id, status]);

  const handleEdit = (id: string) => {
    router.push(`/edit/${id}`);
  };

  const handleDelete = async (id: string) => {
    const character = characters.find((c) => c.id === id);
    const name = character?.name || "персонажа";

    if (!window.confirm(`Удалить персонажа «${name}»?`)) {
      return;
    }

    setDeletingId(id);
    try {
      await axios.delete(`/api/characters/${id}`);
      setCharacters((prev) => prev.filter((c) => c.id !== id));
      setStats((prev) =>
        prev ? { ...prev, charactersCount: Math.max(0, prev.charactersCount - 1) } : prev
      );
      toast.success("Персонаж удалён");
    } catch (err) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Не удалось удалить персонажа";
      toast.error(message);
    } finally {
      setDeletingId(null);
    }
  };

  if (status === "loading") {
    return (
      <div className="min-h-dvh flex flex-col bg-wd-bg text-wd-text">
        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-wd-primary border-t-transparent rounded-full animate-spin" />
        </div>
        <Footer />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="min-h-dvh flex flex-col bg-wd-bg text-wd-text">
        <Toaster position="top-right" />
        <main className="flex-1 flex flex-col items-center justify-center px-4 py-12 text-center gap-4">
          <FaUser className="text-4xl opacity-30 text-wd-primary" />
          <h1 className="text-xl font-black uppercase tracking-tight">Мой профиль</h1>
          <p className="text-xs text-wd-text-secondary max-w-sm">
            Войдите в аккаунт, чтобы просматривать свой профиль и персонажей.
          </p>
          <Link href="/login" className="wd-button px-6 py-2.5 text-sm">
            Войти
          </Link>
        </main>
        <Footer />
      </div>
    );
  }

  const userName = session?.user?.name || session?.user?.email || "Пользователь";
  const userEmail = session?.user?.email || "";
  const userImage = session?.user?.image;
  const initials = getInitials(session?.user?.name, session?.user?.email);
  const registeredAt =
    session?.user?.createdAt || stats?.createdAt || null;

  return (
    <div className="min-h-dvh flex flex-col bg-wd-bg text-wd-text overflow-hidden">
      <Toaster position="top-right" />
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 overflow-y-auto px-2 py-6 scrollbar-subtle sm:px-4 md:gap-6 md:px-6 md:py-8 lg:px-8">
        {/* Profile header */}
        <section className="wd-card p-4 md:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-6">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3 md:gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-wd-border bg-[#0A0A0A] md:h-20 md:w-20">
                {userImage ? (
                  <img src={userImage} alt={userName} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-xl font-black text-wd-primary">{initials}</span>
                )}
              </div>
              <div className="space-y-1">
                <h1 className="truncate text-xl font-black tracking-tight text-white sm:text-2xl md:text-3xl">{userName}</h1>
                {userEmail && (
                  <p className="text-sm text-wd-text-secondary flex items-center gap-2">
                    <FaEnvelope className="text-wd-primary text-xs" />
                    {userEmail}
                  </p>
                )}
                <p className="text-xs text-wd-text-secondary">
                  Дата регистрации:{" "}
                  <span className="font-semibold text-white">{formatRegistrationDate(registeredAt)}</span>
                </p>
              </div>
              <VerseCoinsBalance size="md" className="ml-auto lg:ml-0" />
            </div>

            <div className="flex flex-wrap gap-3 lg:ml-auto">
              <Link href="/create" className="wd-button inline-flex items-center gap-2 px-5 py-2.5 text-xs">
                <FaPlus className="text-[10px]" />
                Создать персонажа
              </Link>
              <Link
                href="/gallery"
                className="inline-flex items-center gap-2 rounded-[50px] border border-wd-border bg-[#0A0A0A] px-5 py-2.5 text-xs font-bold text-white transition-colors hover:border-[#6C63FF]"
              >
                <FaImages className="text-[10px] text-[#6C63FF]" />
                Галерея
              </Link>
            </div>
          </div>
        </section>

        {subscription && (
          <section className="wd-card flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between md:p-6">
            <div className="flex items-start gap-3">
              <FaCrown className="mt-1 shrink-0 text-wd-secondary" />
              <div className="space-y-1">
                <p className="text-xs font-bold uppercase tracking-widest text-wd-text-secondary">
                  Подписка
                </p>
                <h2 className="text-lg font-black text-white">{subscription.subscriptionLabel || "Старт"}</h2>
                {subscription.subscriptionActive && subscription.subscriptionEnd ? (
                  <p className="text-xs text-wd-text-secondary">
                    До {new Date(subscription.subscriptionEnd).toLocaleDateString("ru-RU")} · осталось{" "}
                    {subscription.daysRemaining} дн.
                  </p>
                ) : (
                  <p className="text-xs text-wd-text-secondary">Бесплатный тариф</p>
                )}
                {subscription.pendingSubscriptionLabel && (
                  <p className="text-xs text-wd-secondary">
                    Затем: {subscription.pendingSubscriptionLabel}
                  </p>
                )}
                <p className="text-xs text-wd-text-secondary">
                  {subscription.recurringEnabled ? "Автопродление включено" : "Автопродление отключено"}
                </p>
                {subscription.recurringSetupRequired && (
                  <p className="text-xs text-wd-primary">
                    Для нового тарифа нужно заново настроить автопродление.
                  </p>
                )}
              </div>
            </div>
            <Link href="/subscription" className="wd-button px-5 py-2.5 text-xs">
              Управление подпиской
            </Link>
          </section>
        )}

        {/* Stats */}
        <section className="grid grid-cols-3 gap-2 md:gap-4">
          <div className="wd-card space-y-1 p-3 text-center md:space-y-2 md:p-5">
            <FaRobot className="mx-auto text-base text-wd-primary md:text-lg" />
            <p className="text-[9px] font-bold uppercase tracking-wider text-wd-text-secondary md:text-[11px] md:tracking-widest">
              Персонажи
            </p>
            <p className="text-xl font-black text-white md:text-3xl">
              {statsLoading ? "—" : (stats?.charactersCount ?? 0)}
            </p>
          </div>
          <div className="wd-card space-y-1 p-3 text-center md:space-y-2 md:p-5">
            <FaComments className="mx-auto text-base text-[#6C63FF] md:text-lg" />
            <p className="text-[9px] font-bold uppercase tracking-wider text-wd-text-secondary md:text-[11px] md:tracking-widest">
              Чаты
            </p>
            <p className="text-xl font-black text-white md:text-3xl">
              {statsLoading ? "—" : (stats?.chatsCount ?? 0)}
            </p>
          </div>
          <div className="wd-card space-y-1 p-3 text-center md:space-y-2 md:p-5">
            <FaEnvelope className="mx-auto text-base text-wd-primary md:text-lg" />
            <p className="text-[9px] font-bold uppercase tracking-wider text-wd-text-secondary md:text-[11px] md:tracking-widest">
              Сообщения
            </p>
            <p className="text-xl font-black text-white md:text-3xl">
              {statsLoading ? "—" : (stats?.messagesCount ?? 0)}
            </p>
          </div>
        </section>

        <PersonaManager />

        {/* Characters */}
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-black uppercase tracking-wide text-white">Мои персонажи</h2>
            {!loading && (
              <span className="text-xs text-wd-text-secondary">{characters.length} шт.</span>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-wd-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : error ? (
            <div className="wd-card p-8 text-center">
              <p className="text-sm font-extrabold uppercase text-wd-primary">Ошибка</p>
              <p className="text-xs text-wd-text-secondary max-w-xs mx-auto mt-2">{error}</p>
            </div>
          ) : characters.length === 0 ? (
            <div className="wd-card p-10 text-center space-y-4">
              <FaUser className="text-4xl opacity-20 mx-auto" />
              <h3 className="text-sm font-extrabold uppercase">Вы ещё не создали ни одного персонажа</h3>
              <Link href="/create" className="wd-button inline-flex px-5 py-2.5 text-xs">
                Создать первого персонажа
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 md:gap-6">
              {characters.map((character) => {
                const tags = parseTags(character.tags);
                return (
                  <article key={character.id} className="wd-card overflow-hidden flex flex-col transition-transform hover:-translate-y-1">
                    <div className="aspect-square bg-[#0A0A0A] overflow-hidden relative">
                      {character.imageUrl ? (
                        <img
                          src={character.imageUrl}
                          alt={character.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <FaUser className="text-4xl opacity-20" />
                        </div>
                      )}
                      <FavoriteButton
                        characterId={character.id}
                        initialIsFavorited={Boolean(character.isFavorited)}
                        className="absolute right-2 top-2 z-10 h-8 w-8"
                        iconSize={14}
                      />
                      {!character.isPublic && (
                        <span className="absolute top-2 left-2 text-[9px] uppercase font-bold px-2 py-0.5 rounded bg-[#0A0A0A]/90 text-wd-text-secondary border border-wd-border">
                          Приватный
                        </span>
                      )}
                    </div>

                    <div className="p-4 flex flex-col gap-2 flex-1">
                      <h3 className="text-sm font-extrabold text-white truncate">{character.name}</h3>
                      <p className="text-xs text-wd-text-secondary line-clamp-3 leading-relaxed flex-1">
                        {getCardDescription(character) || "Без описания"}
                      </p>
                      {tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {tags.slice(0, 3).map((tag) => (
                            <span
                              key={tag}
                              className="text-[9px] uppercase tracking-wider font-bold px-2 py-0.5 rounded bg-wd-primary/10 text-wd-primary border border-wd-primary/20"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-col gap-2 pt-2 border-t border-wd-border mt-1">
                        <Link
                          href={`/chat/${character.id}`}
                          className="flex items-center justify-center gap-1.5 py-2 rounded-[50px] text-[10px] font-bold border border-[#6C63FF]/30 bg-[#6C63FF]/10 text-white transition-all hover:bg-[#6C63FF]/20"
                        >
                          Общаться
                        </Link>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleEdit(character.id)}
                            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-[50px] text-[10px] font-bold border border-wd-border bg-[#0A0A0A] text-white transition-all hover:border-[#6C63FF]"
                          >
                            <FaEdit className="text-[9px]" />
                            Редактировать
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(character.id)}
                            disabled={deletingId === character.id}
                            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-[50px] text-[10px] font-bold border border-wd-primary/30 bg-wd-primary/10 text-wd-primary transition-all disabled:opacity-50"
                          >
                            <FaTrash className="text-[9px]" />
                            Удалить
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>

      <Footer />
    </div>
  );
}
