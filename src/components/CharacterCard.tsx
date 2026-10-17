"use client";

import LocaleLink from "@/components/LocaleLink";
import { FaComment, FaUser } from "react-icons/fa";
import { LuTriangleAlert } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import FavoriteButton from "@/components/FavoriteButton";
import { getLocalizedCardDescription, pickLocalizedText, stripLeadingName } from "@/lib/characterFields";
import { pickFeaturedGenre } from "@/lib/characterTags";
import { captureCharacterReturn } from "@/lib/characterReturn";
import { characterAvatarPath } from "@/lib/characterCardImage";

type CharacterCardProps = {
  character: {
    id: string;
    slug?: string | null;
    name: string;
    name_en?: string | null;
    description?: string | null;
    description_en?: string | null;
    descriptionCard?: string | null;
    descriptionCard_en?: string | null;
    tags?: string | null;
    updatedAt?: string | Date | null;
    isFavorited?: boolean;
    totalMessages?: number;
    isPublic?: boolean;
    moderationStatus?: string | null;
  };
  className?: string;
  /** First row of a grid: load at once. Every other card waits until it nears the viewport. */
  eager?: boolean;
  onFavoriteChange?: (characterId: string, isFavorited: boolean) => void;
};

export default function CharacterCard({ character, className = "", eager = false, onFavoriteChange }: CharacterCardProps) {
  const { i18n, t } = useTranslation();
  const locale = i18n.language;
  const totalMessages = character.totalMessages ?? 0;
  const name = pickLocalizedText(character.name, character.name_en, locale) ?? character.name;
  const rawDescription = getLocalizedCardDescription(character, locale);
  const description = rawDescription ? stripLeadingName(rawDescription, name) : t("characterCard.noDescription");
  const genre = pickFeaturedGenre(character.tags);

  const href = character.slug ? `/character/${character.slug}` : `/chat/${character.id}`;
  const avatarUrl = characterAvatarPath(character.id, character.updatedAt);

  return (
    <div className={`group relative min-w-0 w-full max-w-full ${className}`}>
      <LocaleLink
        href={href}
        onClick={captureCharacterReturn}
        className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-wd-bg"
      >
        <article className="relative isolate aspect-[2/3] min-w-0 overflow-hidden rounded-2xl bg-[#1c1926] shadow-wd ring-1 ring-white/5 transition-[transform,box-shadow] duration-300 group-hover:-translate-y-1 group-hover:shadow-[0_14px_36px_rgba(0,0,0,0.55)] group-hover:ring-wd-primary/60 motion-reduce:transform-none">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={name}
              loading={eager ? "eager" : "lazy"}
              decoding="async"
              className="absolute inset-0 -z-20 h-full w-full object-cover object-[center_25%] transition-transform duration-500 group-hover:scale-[1.04] motion-reduce:transform-none"
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
          ) : (
            <div className="absolute inset-0 -z-20 flex items-center justify-center">
              <FaUser className="text-4xl text-wd-text-secondary/30 md:text-5xl" />
            </div>
          )}
          <div
            aria-hidden
            className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,rgba(8,8,10,0.96)_0%,rgba(8,8,10,0.8)_24%,rgba(8,8,10,0.2)_46%,transparent_60%)]"
          />

          {character.moderationStatus === "warning" && character.isPublic === false && (
            <span className="absolute left-2 top-2 max-w-[calc(100%-4rem)] rounded-full border border-orange-500/50 bg-black/70 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-orange-200 backdrop-blur-sm md:left-3 md:top-3">
              <LuTriangleAlert aria-hidden className="mr-1 inline-block align-[-2px]" />
              {t("moderation.hiddenBadge")}
            </span>
          )}

          <div className="absolute inset-x-0 bottom-0 p-2.5 md:p-3.5">
            {genre && (
              <span className="mb-1.5 inline-block rounded-full bg-white/12 px-2 py-0.5 text-[11px] font-semibold text-zinc-200 backdrop-blur-sm md:mb-2">
                {t(`home.genres.${genre.id}`)}
              </span>
            )}
            <h2 className="line-clamp-2 text-[15px] font-bold leading-tight text-white md:text-base">{name}</h2>
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-zinc-300 md:text-[13px]">{description}</p>
            <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-400 md:mt-2">
              <FaComment size={11} aria-hidden />
              <span>
                {t("characterCard.messages", {
                  count: totalMessages,
                  formatted: totalMessages.toLocaleString(locale === "en" ? "en-US" : "ru-RU"),
                })}
              </span>
            </p>
          </div>
        </article>
      </LocaleLink>
      <FavoriteButton
        characterId={character.id}
        initialIsFavorited={Boolean(character.isFavorited)}
        onChange={(isFavorited) => onFavoriteChange?.(character.id, isFavorited)}
        className="absolute right-2 top-2 z-20 h-11 w-11 md:right-3 md:top-3 md:h-10 md:w-10"
        iconSize={16}
      />
    </div>
  );
}
