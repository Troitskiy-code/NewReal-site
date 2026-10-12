"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import Footer from "@/components/Footer";
import { FaComments, FaUser } from "react-icons/fa";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { threadDisplayTitle, withThread, type ChatThreadSummary } from "@/lib/chatThreadShared";

type ChatItem = {
  character: {
    id: string;
    name: string;
    avatarUrl: string | null;
    updatedAt?: string;
  };
  /** Null for a new story without messages yet. */
  lastMessage: {
    id: string;
    role: string;
    content: string;
    createdAt: string;
  } | null;
  /** Present when stories are enabled: one row per story. */
  thread?: ChatThreadSummary;
  count: number;
  lastActivity: string;
};

type ChatsResponse = {
  data: ChatItem[];
  threadsEnabled?: boolean;
};

function formatLastActivity(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function previewMessage(content: string, maxLength = 80) {
  const trimmed = content.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
}

function ChatsPageContent() {
  const { status } = useSession();
  const { t } = useTranslation();
  const [chats, setChats] = useState<ChatItem[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadChats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.get<ChatsResponse>("/api/chats");
      setChats(data.data);
    } catch {
      setError("Не удалось загрузить чаты");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      loadChats();
    } else if (status === "unauthenticated") {
      setLoading(false);
    }
  }, [status, loadChats]);

  if (status === "loading" || loading) {
    return (
      <div className="flex min-h-dvh flex-col overflow-hidden bg-[#121212] text-wd-text">
        <div className="mb-2 w-full border-b border-[#2A2A2A] px-4 py-3 md:py-4">
          <div className="space-y-2">
            <div className="h-7 w-36 animate-pulse rounded bg-white/10" />
            <div className="h-3 w-56 animate-pulse rounded bg-white/10" />
          </div>
        </div>
        <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 pb-6 pt-2 md:gap-4 md:px-6 md:pt-4">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="flex items-center gap-3 rounded-xl border border-[#2A2A2A] bg-[#1A1A1A] p-3 md:gap-4 md:p-4"
            >
              <div className="h-14 w-14 shrink-0 animate-pulse rounded-full bg-white/10 md:h-16 md:w-16" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="h-4 w-32 animate-pulse rounded bg-white/10" />
                  <div className="h-3 w-12 animate-pulse rounded bg-white/10" />
                </div>
                <div className="h-3 w-full max-w-sm animate-pulse rounded bg-white/10" />
                <div className="h-3 w-20 animate-pulse rounded bg-white/10" />
              </div>
            </div>
          ))}
        </main>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="flex min-h-dvh flex-col bg-[#121212] text-wd-text">
        <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12 text-center">
          <FaComments className="text-4xl text-wd-primary-soft opacity-30" />
          <h1 className="text-xl font-bold tracking-tight text-white">Мои чаты</h1>
          <p className="max-w-sm text-xs text-wd-text-secondary">
            Войдите в аккаунт, чтобы видеть историю переписок с персонажами.
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
    <div className="flex min-h-dvh flex-col overflow-hidden bg-[#121212] text-wd-text">

      <div className="mb-2 w-full border-b border-[#2A2A2A] px-4 py-3 md:py-4">
        <div className="space-y-1">
          <h1 className="text-xl font-bold tracking-tight text-white md:text-2xl">Мои чаты</h1>
          <p className="text-xs text-wd-text-secondary">
            Персонажи, с которыми вы уже общались
            {!loading && chats.length > 0 && ` · ${chats.length}`}
          </p>
        </div>
      </div>

      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-6 pt-2 scrollbar-subtle md:gap-4 md:px-6 md:pt-4">
        {error ? (
          <div className="rounded-wd border border-wd-primary/30 bg-wd-card p-10 text-center shadow-wd">
            <p className="text-sm font-semibold text-wd-primary-soft">Ошибка</p>
            <p className="mx-auto mt-2 max-w-xs text-xs text-wd-text-secondary">{error}</p>
            <button type="button" onClick={loadChats} className="wd-button mt-4 px-5 py-2.5 text-xs">
              Повторить
            </button>
          </div>
        ) : chats.length === 0 ? (
          <div className="rounded-wd border border-wd-border bg-wd-card p-10 text-center shadow-wd">
            <FaComments className="mx-auto mb-4 text-4xl opacity-20" />
            <h3 className="text-sm font-semibold text-white">Чатов пока нет</h3>
            <p className="mx-auto mt-2 max-w-xs text-xs text-wd-text-secondary">
              Начните диалог с любым персонажем — он появится в этом списке.
            </p>
            <Link href="/" className="wd-button mt-4 inline-flex px-5 py-2.5 text-xs">
              Выбрать персонажа
            </Link>
          </div>
        ) : (
          [
            ...chats.filter((chat) => chat.thread?.status !== "archived"),
            ...(showArchived ? chats.filter((chat) => chat.thread?.status === "archived") : []),
          ].map((chat) => (
            <Link
              key={chat.thread?.id ?? chat.character.id}
              href={withThread(`/chat/${chat.character.id}`, chat.thread?.id)}
              className="flex items-center gap-3 rounded-xl border border-[#2A2A2A] bg-[#1A1A1A] p-3 transition-colors hover:border-wd-secondary/40 md:gap-4 md:p-4"
            >
              <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full border border-[#2A2A2A] bg-[#0A0A0A] md:h-16 md:w-16">
                <div className="flex h-full w-full items-center justify-center">
                  <FaUser className="text-xl text-wd-text-secondary/40" />
                </div>
                {chat.character.avatarUrl ? (
                <img
                  src={chat.character.avatarUrl}
                  alt={chat.character.name}
                  className="absolute inset-0 h-full w-full object-cover"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
                ) : null}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="truncate text-base font-bold text-white">{chat.character.name}</h2>
                  <span className="shrink-0 text-[11px] text-wd-text-secondary">
                    {formatLastActivity(chat.lastActivity)}
                  </span>
                </div>
                {chat.thread ? (
                  <p className="mt-0.5 flex items-center gap-2 truncate text-xs font-semibold text-wd-secondary-text">
                    <span className="truncate">{threadDisplayTitle(chat.thread, t)}</span>
                    {chat.thread.status === "archived" ? (
                      <span className="shrink-0 rounded-wd-pill bg-white/10 px-2 py-0.5 text-[10px] font-normal text-wd-text-secondary">{t("chatThreads.archived")}</span>
                    ) : null}
                  </p>
                ) : null}
                <p className="mt-1 line-clamp-2 text-xs leading-snug text-gray-400">
                  {chat.lastMessage ? (
                    <>
                      {chat.lastMessage.role === "user" ? "Вы: " : ""}
                      {previewMessage(chat.lastMessage.content)}
                    </>
                  ) : t("chatThreads.empty")}
                </p>
                <p className="mt-1 text-[11px] text-wd-text-secondary">
                  {chat.count} {chat.count === 1 ? "сообщение" : chat.count < 5 ? "сообщения" : "сообщений"}
                </p>
              </div>
            </Link>
          ))
        )}
        {!error && chats.some((chat) => chat.thread?.status === "archived") ? (
          <button
            type="button"
            onClick={() => setShowArchived((value) => !value)}
            aria-expanded={showArchived}
            className="self-start rounded-wd-pill border border-wd-border px-4 py-2 text-xs font-bold text-wd-text-secondary transition-colors hover:border-wd-secondary hover:text-white"
          >
            {t("chatThreads.archiveSection", { count: chats.filter((chat) => chat.thread?.status === "archived").length })}
          </button>
        ) : null}
      </main>

      <Footer />
    </div>
  );
}

export default function ChatsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-[#121212]">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
        </div>
      }
    >
      <ChatsPageContent />
    </Suspense>
  );
}
