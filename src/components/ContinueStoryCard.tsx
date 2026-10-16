"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { LuPlay } from "react-icons/lu";
import LocaleLink from "@/components/LocaleLink";
import { threadDisplayTitle, withThread, type ChatThreadSummary } from "@/lib/chatThreadShared";

type LatestChat = {
  lastActivity: string;
  character: { id: string; name: string; avatarUrl: string | null };
  lastMessage: { role: string; content: string } | null;
  thread?: ChatThreadSummary;
};

/** First line of the last message without markdown emphasis (the API sends a short prefix). */
function teaser(content: string): string {
  return content.split(/\r?\n/).map((line) => line.replace(/\*/g, "").trim()).find(Boolean) ?? "";
}

/** "Продолжить историю": the most recent story of a signed-in user, first thing on the home page. */
export default function ContinueStoryCard() {
  const { status } = useSession();
  const { t } = useTranslation();
  const [latest, setLatest] = useState<LatestChat | null>(null);

  useEffect(() => {
    if (status !== "authenticated") return;
    const controller = new AbortController();
    axios.get<{ data: LatestChat[] }>("/api/chats", { signal: controller.signal })
      .then(({ data }) => {
        const recent = data.data
          .filter((chat) => chat.thread?.status !== "archived" && chat.lastMessage)
          .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
        setLatest(recent[0] ?? null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [status]);

  if (status !== "authenticated" || !latest) return null;

  const line = latest.lastMessage ? teaser(latest.lastMessage.content) : "";
  const href = withThread(`/chat/${latest.character.id}`, latest.thread?.id);

  return (
    <section className="px-4 pt-4 md:px-6 md:pt-6" aria-labelledby="continue-story-title">
      <LocaleLink
        href={href}
        className="group relative isolate flex h-48 overflow-hidden rounded-3xl bg-wd-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary md:h-56 md:max-w-3xl"
      >
        {latest.character.avatarUrl ? (
          <img
            src={latest.character.avatarUrl}
            alt=""
            className="absolute inset-0 -z-20 h-full w-full object-cover object-[center_25%] transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transform-none"
          />
        ) : null}
        <span aria-hidden className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,rgba(12,11,18,0.96)_8%,rgba(12,11,18,0.35)_65%,rgba(12,11,18,0.15))]" />
        <span className="absolute left-4 top-4 inline-flex h-7 items-center rounded-full bg-wd-bg/75 px-3 text-xs font-semibold text-wd-text backdrop-blur-sm">
          {t("home.continue.label")}
          {latest.thread ? ` · ${threadDisplayTitle(latest.thread, t)}` : ""}
        </span>
        <span className="mt-auto flex w-full items-end justify-between gap-4 p-4 md:p-5">
          <span className="flex min-w-0 flex-col gap-1">
            <span id="continue-story-title" className="truncate font-display text-xl font-semibold text-wd-text md:text-2xl">
              {latest.character.name}
            </span>
            {line ? (
              <span className="line-clamp-2 font-story text-[14px] italic leading-snug text-wd-story-muted md:text-[15px]">
                {latest.lastMessage?.role === "user" ? `${t("home.continue.you")}: ` : ""}{line}
              </span>
            ) : null}
          </span>
          <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-wd-primary text-white transition-colors group-hover:bg-wd-primary-hover">
            <LuPlay size={20} className="ml-0.5 fill-current" />
          </span>
        </span>
      </LocaleLink>
    </section>
  );
}
