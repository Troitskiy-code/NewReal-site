"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import axios from "axios";
import { LuPlus } from "react-icons/lu";
import { threadDisplayTitle, withThread, type ChatThreadSummary } from "@/lib/chatThreadShared";
import { useTranslation } from "react-i18next";
import { showError, showSuccess } from "@/lib/toast";
import { FaComments, FaShareAlt, FaTimes, FaUser } from "react-icons/fa";
import LocaleLink, { useCurrentLocale } from "@/components/LocaleLink";
import { getLocalizedCardDescription, pickLocalizedMemory, pickLocalizedText } from "@/lib/characterFields";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";
import { dateLocale, withLocale } from "@/lib/i18nConfig";
import { closeCharacterPage } from "@/lib/characterReturn";
import { characterAvatarPath } from "@/lib/characterCardImage";
import ModerationWarning from "@/components/ModerationWarning";

export type CharacterPublicViewData = {
  id: string;
  slug: string;
  name: string;
  name_en: string | null;
  description: string | null;
  description_en: string | null;
  descriptionCard: string | null;
  descriptionCard_en: string | null;
  imageUrl: string | null;
  publicMemory: unknown;
  publicMemory_en: unknown;
  totalMessages: number;
  createdAt: string;
  updatedAt?: string | null;
  user: {
    name: string | null;
    image: string | null;
  };
  moderationStatus?: string | null;
  moderationReason?: string | null;
};

export default function CharacterPublicView({ character }: { character: CharacterPublicViewData }) {
  const { t } = useTranslation();
  const router = useRouter();
  const locale = useCurrentLocale();
  const [copied, setCopied] = useState(false);
  const { status } = useSession();
  // Signed-in only, and only when stories are enabled (the list endpoint is 404 otherwise).
  const [loadedThread, setLoadedThread] = useState<{ characterId: string; thread: ChatThreadSummary | null } | null>(null);
  useEffect(() => {
    if (status !== "authenticated") return;
    const controller = new AbortController();
    axios.get<{ threads: ChatThreadSummary[] }>(`/api/chat/${character.id}/threads`, { signal: controller.signal })
      .then(({ data }) => setLoadedThread({ characterId: character.id, thread: data.threads.find((thread) => thread.status === "active") ?? null }))
      .catch(() => setLoadedThread({ characterId: character.id, thread: null }));
    return () => controller.abort();
  }, [status, character.id]);
  const latestThread = status === "authenticated" && loadedThread?.characterId === character.id ? loadedThread.thread : null;
  const name = pickLocalizedText(character.name, character.name_en, locale) ?? character.name;
  const description = getLocalizedCardDescription(character, locale) || "";
  const publicMemory = pickLocalizedMemory(character.publicMemory, character.publicMemory_en, locale);
  const author = character.user?.name?.trim() || t("characterPage.unknownAuthor");
  const createdAt = new Date(character.createdAt).toLocaleDateString(dateLocale(locale), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const handleClose = useCallback(() => {
    closeCharacterPage(router, withLocale("/", locale));
  }, [locale, router]);

  useEffect(() => {
    reachGoal(METRIKA_GOALS.characterPageView);
    console.log("[Character] Page view", { slug: character.slug, id: character.id });
  }, [character.id, character.slug]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      event.preventDefault();
      handleClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleClose]);

  const handleShare = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      showSuccess(t("characterPage.copied"));
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showError(t("characterPage.shareFailed"));
    }
  };

  const chatHref = `/chat/${character.id}`;
  const avatarUrl = characterAvatarPath(character.id, character.updatedAt);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <button
        type="button"
        onClick={handleClose}
        className="fixed right-3 top-16 z-[70] flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/45 text-white backdrop-blur-sm transition-colors hover:border-white/40 hover:bg-black/70 md:right-5 md:top-[5.75rem]"
        aria-label={t("characterPage.close")}
        title={t("characterPage.close")}
      >
        <FaTimes size={16} />
      </button>
      {/* No overflow-hidden here: it would make the card the scroll box of the sticky action bar. */}
      <div className="rounded-wd border border-wd-border bg-wd-card shadow-wd max-sm:-mx-4 max-sm:-mt-8 max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent max-sm:shadow-none">
        {/* Phones: the portrait runs edge to edge and fades into the page under the name. */}
        <div className="relative aspect-[4/5] max-h-[64svh] w-full overflow-hidden bg-wd-bg sm:aspect-[16/9] sm:max-h-none sm:rounded-t-wd">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={name}
              // Portraits are 2:3 with the face in the upper third; a centred crop in the wide frame cut it off.
              className="h-full w-full object-cover object-[center_22%]"
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <FaUser className="text-6xl text-wd-text-secondary/30" />
            </div>
          )}
          <span aria-hidden className="absolute inset-0 bg-[linear-gradient(to_top,var(--color-wd-bg)_0%,rgba(12,11,18,0.4)_30%,transparent_55%)] sm:hidden" />
        </div>

        <div className="relative space-y-4 p-5 max-sm:-mt-16 max-sm:px-4 sm:p-6">
          {character.moderationStatus === "warning" && (
            <ModerationWarning reason={character.moderationReason} />
          )}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="font-display text-[28px] font-semibold leading-tight tracking-tight text-white sm:text-3xl">{name}</h1>
              <p className="mt-1 text-xs text-wd-text-secondary">
                {t("characterPage.author")}: {author}
                {" · "}
                {createdAt}
              </p>
            </div>
            <p className="flex items-center gap-1.5 rounded-wd-pill bg-wd-card px-3 py-1.5 text-xs font-bold text-white">
              <FaComments className="text-wd-text-secondary" />
              {t("characterPage.messages", { count: (character.totalMessages ?? 0).toLocaleString(dateLocale(locale)) })}
            </p>
          </div>

          {description ? (
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-wd-text/85">{description}</p>
          ) : null}

          {publicMemory ? (
            <div className="rounded-2xl bg-wd-elevated p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-wd-secondary">
                {t("characterPage.knownAbout")}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-200">{publicMemory}</p>
            </div>
          ) : null}

          {/* Phones: a bar that sticks above the bottom nav (globals.css), secondary actions shrink to icons. */}
          <div className="nv-sticky-cta flex gap-2 max-md:-mx-5 max-md:-mb-5 max-md:rounded-b-wd max-md:border-t max-md:border-wd-border max-md:bg-wd-card/95 max-md:px-5 max-md:py-3 max-md:backdrop-blur-md max-sm:-mx-4 max-sm:rounded-none max-sm:bg-wd-bg/95 max-sm:px-4 sm:max-md:-mx-6 sm:max-md:-mb-6 sm:max-md:px-6">
            {latestThread ? (
              <>
                <LocaleLink href={withThread(chatHref, latestThread.id)} className="wd-button flex min-w-0 flex-1 items-center justify-center gap-2 py-3 text-sm">
                  <FaComments className="shrink-0" />
                  <span className="truncate">{t("chatThreads.continueNamed", { title: threadDisplayTitle(latestThread, t) })}</span>
                </LocaleLink>
                <LocaleLink
                  href={`${chatHref}?new=1`}
                  title={t("chatThreads.newStory")}
                  className="flex shrink-0 items-center justify-center gap-2 rounded-wd-pill border border-wd-primary/40 bg-wd-primary/10 px-4 py-3 text-sm font-bold text-wd-primary-soft transition-colors hover:bg-wd-primary/20 max-sm:w-12 max-sm:px-0 sm:flex-1"
                >
                  <LuPlus aria-hidden className="shrink-0" />
                  <span className="max-sm:sr-only">{t("chatThreads.newStory")}</span>
                </LocaleLink>
              </>
            ) : (
              <LocaleLink href={chatHref} className="wd-button flex flex-1 items-center justify-center gap-2 py-3 text-sm">
                <FaComments />
                {t("characterPage.startChat")}
              </LocaleLink>
            )}
            <button
              type="button"
              onClick={handleShare}
              title={t("characterPage.share")}
              className="flex shrink-0 items-center justify-center gap-2 rounded-wd-pill border border-wd-border bg-wd-card px-4 py-3 text-sm font-bold text-white transition-colors hover:border-wd-secondary max-sm:w-12 max-sm:px-0 sm:flex-1"
            >
              <FaShareAlt aria-hidden className="shrink-0" />
              <span className="max-sm:sr-only">{copied ? t("characterPage.copied") : t("characterPage.share")}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
