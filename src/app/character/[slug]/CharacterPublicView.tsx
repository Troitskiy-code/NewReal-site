"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import toast, { Toaster } from "react-hot-toast";
import { FaComments, FaShareAlt, FaUser } from "react-icons/fa";
import LocaleLink from "@/components/LocaleLink";
import { pickLocalizedText } from "@/lib/characterFields";
import { memoryToText } from "@/lib/persistentMemory";
import { METRIKA_GOALS, reachGoal } from "@/lib/metrika";
import { dateLocale } from "@/lib/i18nConfig";

export type CharacterPublicViewData = {
  id: string;
  slug: string;
  name: string;
  name_en: string | null;
  description: string | null;
  description_en: string | null;
  descriptionCard: string | null;
  imageUrl: string | null;
  publicMemory: unknown;
  totalMessages: number;
  createdAt: string;
  user: {
    name: string | null;
    image: string | null;
  };
};

export default function CharacterPublicView({ character }: { character: CharacterPublicViewData }) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const locale = i18n.language;
  const name = pickLocalizedText(character.name, character.name_en, locale) ?? character.name;
  const description = character.descriptionCard?.trim() || "";
  const publicMemory = memoryToText(character.publicMemory).trim();
  const author = character.user.name?.trim() || t("characterPage.unknownAuthor");
  const createdAt = new Date(character.createdAt).toLocaleDateString(dateLocale(locale), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  useEffect(() => {
    reachGoal(METRIKA_GOALS.characterPageView);
    console.log("[Character] Page view", { slug: character.slug, id: character.id });
  }, [character.id, character.slug]);

  const handleShare = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(t("characterPage.copied"));
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("characterPage.shareFailed"));
    }
  };

  const chatHref = `/chat/${character.id}`;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Toaster position="top-right" />
      <div className="overflow-hidden rounded-wd border border-wd-border bg-wd-card shadow-wd">
        <div className="relative aspect-[4/3] bg-[#0A0A0A] sm:aspect-[16/9]">
          {character.imageUrl ? (
            <img src={character.imageUrl} alt={name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <FaUser className="text-6xl text-wd-text-secondary/30" />
            </div>
          )}
        </div>

        <div className="space-y-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">{name}</h1>
              <p className="mt-1 text-xs text-wd-text-secondary">
                {t("characterPage.author")}: {author}
                {" · "}
                {createdAt}
              </p>
            </div>
            <p className="flex items-center gap-1.5 rounded-wd-pill border border-wd-border bg-[#0A0A0A] px-3 py-1.5 text-xs font-bold text-white">
              <FaComments className="text-wd-text-secondary" />
              {t("characterPage.messages", { count: character.totalMessages.toLocaleString(dateLocale(locale)) })}
            </p>
          </div>

          {description ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-wd-text-secondary">{description}</p>
          ) : null}

          {publicMemory ? (
            <div className="rounded-wd border border-wd-border bg-[#0A0A0A] p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-wd-secondary">
                {t("characterPage.knownAbout")}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-200">{publicMemory}</p>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <LocaleLink href={chatHref} className="wd-button flex flex-1 items-center justify-center gap-2 py-3 text-sm">
              <FaComments />
              {t("characterPage.startChat")}
            </LocaleLink>
            <button
              type="button"
              onClick={handleShare}
              className="flex flex-1 items-center justify-center gap-2 rounded-wd-pill border border-wd-border bg-[#0A0A0A] px-4 py-3 text-sm font-bold text-white transition-colors hover:border-wd-secondary"
            >
              <FaShareAlt />
              {copied ? t("characterPage.copied") : t("characterPage.share")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
