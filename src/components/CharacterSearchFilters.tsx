"use client";

import { FaSearch, FaTimes } from "react-icons/fa";
import { useTranslation } from "react-i18next";
import { CHARACTER_SORT_OPTIONS, type CharacterSort } from "@/lib/characterSort";
import { FEATURED_GENRES, canonicalCharacterTag } from "@/lib/characterTags";

const SORT_LABEL_KEYS: Record<CharacterSort, string> = {
  top: "home.sortTop",
  random: "home.sortRandom",
  new: "home.sortNew",
  "for-you": "home.sortForYou",
};

type CharacterSearchFiltersProps = {
  search: string;
  onSearchChange: (value: string) => void;
  sort: CharacterSort;
  onSortChange: (sort: CharacterSort) => void;
  placeholder?: string;
};

const chipClassName =
  "inline-flex min-h-9 shrink-0 items-center rounded-full border px-3.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary";

export default function CharacterSearchFilters({
  search,
  onSearchChange,
  sort,
  onSortChange,
  placeholder,
}: CharacterSearchFiltersProps) {
  const { t } = useTranslation();
  const query = search.trim();
  const hasFilters = query.length > 0;
  const searchPlaceholder = placeholder || t("home.searchPlaceholder");
  const activeGenre = FEATURED_GENRES.find((genre) => genre.tag === canonicalCharacterTag(query));

  return (
    <section className="mb-2 w-full shrink-0 px-4 pt-4 md:mb-4 md:px-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative min-w-0 flex-1 md:max-w-xl">
          <FaSearch className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm text-wd-text-secondary" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-11 w-full rounded-full border border-wd-border bg-wd-card py-0 pl-11 pr-11 text-sm text-white outline-none transition-colors placeholder:text-wd-text-secondary focus:border-wd-secondary/60 [&::-webkit-search-cancel-button]:hidden"
          />
          {hasFilters && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-wd-text-secondary transition-colors hover:bg-white/10 hover:text-white"
              aria-label={t("home.resetSearch")}
              title={t("home.resetSearch")}
            >
              <FaTimes className="text-xs" />
            </button>
          )}
        </div>

        <div
          role="group"
          aria-label={t("home.sort")}
          className="flex shrink-0 self-start rounded-full border border-wd-border bg-wd-card p-1 md:ml-auto md:self-auto"
        >
          {CHARACTER_SORT_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onSortChange(option.id)}
              aria-pressed={sort === option.id}
              className={`min-h-9 rounded-full px-3.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary ${
                sort === option.id ? "bg-white/12 text-white" : "text-wd-text-secondary hover:text-white"
              }`}
            >
              {t(SORT_LABEL_KEYS[option.id])}
            </button>
          ))}
        </div>
      </div>

      <div
        role="group"
        aria-label={t("home.genresLabel")}
        className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0 [&::-webkit-scrollbar]:hidden"
      >
        <button
          type="button"
          onClick={() => onSearchChange("")}
          aria-pressed={!hasFilters}
          className={`${chipClassName} ${
            !hasFilters ? "border-transparent bg-wd-primary text-white" : "border-wd-border bg-wd-card text-wd-text-secondary hover:text-white"
          }`}
        >
          {t("home.allGenres")}
        </button>
        {FEATURED_GENRES.map((genre) => {
          const active = activeGenre?.id === genre.id;
          return (
            <button
              key={genre.id}
              type="button"
              onClick={() => onSearchChange(active ? "" : genre.tag)}
              aria-pressed={active}
              className={`${chipClassName} ${
                active ? "border-transparent bg-wd-primary text-white" : "border-wd-border bg-wd-card text-wd-text-secondary hover:text-white"
              }`}
            >
              {t(`home.genres.${genre.id}`)}
            </button>
          );
        })}
      </div>
    </section>
  );
}
