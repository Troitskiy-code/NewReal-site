"use client";

import { FaChevronDown, FaSearch, FaTimes } from "react-icons/fa";
import { CHARACTER_SORT_OPTIONS, type CharacterSort } from "@/lib/characterSort";

type CharacterSearchFiltersProps = {
  search: string;
  onSearchChange: (value: string) => void;
  sort: CharacterSort;
  onSortChange: (sort: CharacterSort) => void;
  placeholder?: string;
};

const controlClassName =
  "h-11 rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] text-sm text-white outline-none transition-colors placeholder:text-[#A0A0A0] focus:border-[#6C63FF]/50";

export default function CharacterSearchFilters({
  search,
  onSearchChange,
  sort,
  onSortChange,
  placeholder = "Поиск по имени или тегу...",
}: CharacterSearchFiltersProps) {
  const hasFilters = search.trim().length > 0;

  return (
    <section className="mb-4 w-full shrink-0 border-b border-[#2A2A2A] bg-[#121212] px-4 pb-4 pt-3 md:mb-6 md:py-4">
      <div className="flex flex-wrap items-center gap-2 md:gap-3">
        <div className="relative min-w-0 w-full flex-1 basis-full min-[520px]:basis-auto min-[520px]:min-w-[200px] md:min-w-[240px]">
          <FaSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[#A0A0A0]" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={placeholder}
            className={`${controlClassName} w-full py-0 pl-10 pr-3`}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 max-[519px]:w-full sm:flex-nowrap md:flex-none md:shrink-0">
          <div className="relative min-w-[108px] flex-1 sm:flex-none sm:w-[130px] md:w-[140px]">
            <select
              value={sort}
              onChange={(e) => onSortChange(e.target.value as CharacterSort)}
              className={`${controlClassName} w-full appearance-none py-0 pl-3 pr-8 font-semibold`}
              aria-label="Сортировка"
            >
              {CHARACTER_SORT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id} className="bg-[#1A1A1A] text-white">
                  {option.label}
                </option>
              ))}
            </select>
            <FaChevronDown
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-[#A0A0A0]"
              aria-hidden
            />
          </div>

          {hasFilters && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] px-3 text-xs font-bold text-[#A0A0A0] transition-colors hover:text-white md:px-4"
              title="Сбросить поиск"
            >
              <FaTimes className="text-[10px]" />
              <span className="hidden min-[360px]:inline">Сбросить</span>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
