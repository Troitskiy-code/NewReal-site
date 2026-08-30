"use client";

import Link from "next/link";
import { FaComments, FaUser } from "react-icons/fa";
import FavoriteButton from "@/components/FavoriteButton";
import { getCardDescription } from "@/lib/characterFields";

type CharacterCardProps = {
  character: {
    id: string;
    name: string;
    description?: string | null;
    descriptionCard?: string | null;
    imageUrl?: string | null;
    isFavorited?: boolean;
    totalMessages?: number;
  };
  className?: string;
  onFavoriteChange?: (characterId: string, isFavorited: boolean) => void;
};

export default function CharacterCard({ character, className = "", onFavoriteChange }: CharacterCardProps) {
  const totalMessages = character.totalMessages ?? 0;
  const description = getCardDescription(character) || "Без описания";

  return (
    <Link href={`/chat/${character.id}`} className={`group block min-w-0 w-full max-w-full ${className}`}>
      <article className="relative h-[260px] min-w-0 overflow-hidden rounded-xl border border-wd-border bg-[#2A2A2A] shadow-wd transition-all duration-300 max-[400px]:h-[240px] md:h-[340px] md:rounded-3xl lg:h-[380px] hover:-translate-y-0.5 hover:border-wd-secondary/50 hover:shadow-[0_12px_32px_rgba(108,99,255,0.18)] md:hover:-translate-y-1 md:hover:scale-[1.02] md:hover:shadow-[0_16px_48px_rgba(108,99,255,0.2)]">
        <div className="absolute inset-0 overflow-hidden">
          {character.imageUrl ? (
            <img
              src={character.imageUrl}
              alt={character.name}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[#2A2A2A]">
              <FaUser className="text-3xl text-wd-text-secondary/30 max-[400px]:text-2xl md:text-5xl" />
            </div>
          )}

          <div className="absolute left-1.5 top-1.5 z-10 flex items-center gap-1 rounded-full border border-white/10 bg-black/55 px-1.5 py-0.5 backdrop-blur-sm max-[400px]:left-1 max-[400px]:top-1 md:left-3 md:top-3 md:gap-1.5 md:px-2.5 md:py-1.5">
            <FaComments className="text-wd-text-secondary" size={11} />
            <span className="text-[11px] font-semibold leading-none text-white">
              {totalMessages.toLocaleString("ru-RU")}
            </span>
          </div>

          <FavoriteButton
            characterId={character.id}
            initialIsFavorited={Boolean(character.isFavorited)}
            onChange={(isFavorited) => onFavoriteChange?.(character.id, isFavorited)}
            className="absolute right-1.5 top-1.5 z-10 h-7 w-7 max-[400px]:right-1 max-[400px]:top-1 md:right-3 md:top-3 md:h-9 md:w-9"
            iconSize={12}
          />
        </div>

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />

        <div className="absolute bottom-0 left-0 right-0 z-10 bg-black/30 px-2.5 py-2 backdrop-blur-sm max-[400px]:px-2 max-[400px]:py-1.5 md:bg-transparent md:px-4 md:py-4 md:backdrop-blur-none">
          <h2 className="truncate text-base font-bold leading-tight text-white drop-shadow">{character.name}</h2>
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-gray-200 drop-shadow md:text-gray-400">
            {description}
          </p>
        </div>
      </article>
    </Link>
  );
}
