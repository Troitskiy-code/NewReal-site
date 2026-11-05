"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FaSearch, FaSlidersH, FaTimes } from "react-icons/fa";
import { LuChevronDown, LuChevronRight, LuChevronUp, LuX } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import { VerseCoinMark } from "@/components/Logo";
import { useCurrentLocale } from "@/components/LocaleLink";
import { useCatalogFacets } from "@/hooks/useCatalogFacets";
import {
  CATALOG_FORMATS, CATALOG_GENDERS, CATALOG_GENDER_TAGS, CATALOG_GENRE_TAGS, CATALOG_QUICK_GENRES, CATALOG_STYLES, CATALOG_TRAIT_TAGS, CATALOG_WORLD_TAGS,
  catalogFilterCount, catalogFiltersQuery, EMPTY_CATALOG_FILTERS, catalogOptionKey, isCatalogOptionActive, selectedCatalogOptions, toggleCatalogOption,
  type CatalogFacets, type CatalogFilterOption, type CatalogFilters,
} from "@/lib/catalogFilters";
import { CHARACTER_SORT_OPTIONS, type CharacterSort } from "@/lib/characterSort";
import { characterTagLabel, FEATURED_GENRES } from "@/lib/characterTags";
import { genrePath } from "@/lib/genreSeo";
import { withLocale } from "@/lib/i18nConfig";

const SORT_LABEL_KEYS: Record<CharacterSort, string> = {
  top: "home.sortTop",
  random: "home.sortRandom",
  new: "home.sortNew",
  "for-you": "home.sortForYou",
};

type GroupId = "style" | "gender" | "format" | "genres" | "worlds" | "traits";
const GROUP_OPTIONS: Record<GroupId, CatalogFilterOption[]> = {
  style: CATALOG_STYLES.map(id => ({ group: "style", id })),
  gender: CATALOG_GENDERS.map(id => ({ group: "gender", id })),
  format: CATALOG_FORMATS.map(id => ({ group: "format", id })),
  genres: Object.keys(CATALOG_GENRE_TAGS).map(id => ({ group: "genres", id })),
  worlds: Object.keys(CATALOG_WORLD_TAGS).map(id => ({ group: "worlds", id })),
  traits: Object.keys(CATALOG_TRAIT_TAGS).map(id => ({ group: "traits", id })),
};
const GROUP_ORDER: GroupId[] = ["style", "gender", "format", "genres", "worlds", "traits"];

function useOptionLabel() {
  const { t } = useTranslation();
  const locale = useCurrentLocale();
  const tag = (value: string) => characterTagLabel(value, locale, (key, fallback) => t(key, { defaultValue: fallback }));
  return (option: CatalogFilterOption): string => {
    if (option.group === "style") return t(`onboarding.styleLabel.${option.id}`);
    if (option.group === "gender") return t(`home.filters.gender.${option.id}`, { defaultValue: tag(CATALOG_GENDER_TAGS[option.id]) });
    if (option.group === "format") return t(`home.filters.format.${option.id}`);
    if (option.group === "genres") return tag(CATALOG_GENRE_TAGS[option.id]);
    if (option.group === "worlds") return tag(CATALOG_WORLD_TAGS[option.id]);
    return tag(CATALOG_TRAIT_TAGS[option.id]);
  };
}

type OptionChipsProps = {
  options: CatalogFilterOption[];
  filters: CatalogFilters;
  facets: CatalogFacets | null;
  onToggle: (option: CatalogFilterOption) => void;
  children?: ReactNode;
};

/** A choice that would leave nothing is switched off; a selected one can always be removed. */
function OptionChips({ options, filters, facets, onToggle, children }: OptionChipsProps) {
  const label = useOptionLabel();
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const active = isCatalogOptionActive(filters, option);
        const dead = !active && facets?.options[catalogOptionKey(option)] === 0;
        return (
          <button
            key={catalogOptionKey(option)}
            type="button"
            aria-pressed={active}
            disabled={dead}
            onClick={() => onToggle(option)}
            className={`min-h-11 rounded-full px-3.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary ${
              active ? "bg-wd-text font-semibold text-wd-bg"
                : dead ? "cursor-not-allowed border border-dashed border-wd-border bg-transparent font-medium text-[#6f6a82]"
                : "bg-[#221f2e] font-semibold text-[#e4e1ec] hover:bg-[#2a2638] hover:text-white"
            }`}
          >
            {label(option)}
          </button>
        );
      })}
      {children}
    </div>
  );
}

function AdultSwitch({ hideAdult, onChange, compact = false }: { hideAdult: boolean; onChange: (hide: boolean) => void; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!hideAdult}
      onClick={() => onChange(!hideAdult)}
      className={`flex items-center justify-between gap-2 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary ${
        compact ? "min-h-11 rounded-full bg-wd-card pl-3.5 pr-2 text-sm text-[#d8d3e5]" : "min-h-[50px] w-full text-[15px] text-wd-text"
      }`}
    >
      {compact ? "18+" : t("home.filters.showAdult")}
      <span aria-hidden className={`relative h-[22px] w-9 shrink-0 rounded-full transition-colors ${hideAdult ? "bg-white/15" : "bg-wd-primary"}`}>
        <span className={`absolute top-[3px] h-4 w-4 rounded-full bg-white transition-[left] ${hideAdult ? "left-[3px]" : "left-[17px]"}`} />
      </span>
    </button>
  );
}

type FiltersSheetProps = {
  filters: CatalogFilters;
  facets: CatalogFacets | null;
  hideAdult: boolean;
  onHideAdultChange: (hide: boolean) => void;
  onToggle: (option: CatalogFilterOption) => void;
  onReset: () => void;
  onClose: () => void;
  fallbackTotal: number;
};

/** Phones: one panel from the bottom. Choices apply at once; the button shows the result and closes. */
function FiltersSheet({ filters, facets, hideAdult, onHideAdultChange, onToggle, onReset, onClose, fallbackTotal }: FiltersSheetProps) {
  const { t } = useTranslation();
  const label = useOptionLabel();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [allGenres, setAllGenres] = useState(false);
  const [openRow, setOpenRow] = useState<"worlds" | "traits" | null>(null);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", onKeyDown); };
  }, [onClose]);

  const quick: readonly string[] = CATALOG_QUICK_GENRES;
  const shownGenres = allGenres ? GROUP_OPTIONS.genres
    : GROUP_OPTIONS.genres.filter(option => quick.includes(option.id) || isCatalogOptionActive(filters, option));
  const hiddenGenres = GROUP_OPTIONS.genres.length - shownGenres.length;
  const legend = "mb-2 text-[13px] font-semibold text-wd-text-secondary";
  const summary = (group: "worlds" | "traits") => {
    const chosen = selectedCatalogOptions(filters).filter(option => option.group === group);
    return chosen.length ? chosen.map(label).join(", ") : t("home.filters.any");
  };
  const total = facets?.total ?? fallbackTotal;

  // On body: the filter section is its own stacking context, under the fixed bottom navigation.
  return createPortal(
    <div className="fixed inset-0 z-[70] md:hidden">
      <button type="button" tabIndex={-1} aria-label={t("common.close")} onClick={onClose} className="absolute inset-0 bg-black/70" />
      <section role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="absolute inset-x-0 bottom-0 top-11 flex flex-col rounded-t-3xl border-t border-wd-border bg-wd-card pb-[env(safe-area-inset-bottom)]">
        <div className="flex justify-center pt-2" aria-hidden><span className="h-1 w-10 rounded bg-[#3a3550]" /></div>
        <header className="flex items-center justify-between py-1.5 pl-5 pr-2">
          <h2 id={titleId} className="font-display text-xl font-semibold">{t("home.filters.button")}</h2>
          <div className="flex items-center">
            <button type="button" onClick={onReset} className="min-h-11 px-2.5 text-sm font-semibold text-wd-text-secondary hover:text-white">{t("home.filters.reset")}</button>
            <button ref={closeRef} type="button" onClick={onClose} aria-label={t("common.close")} className="grid h-11 w-11 place-items-center text-wd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary">
              <LuX size={20} aria-hidden />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto overscroll-contain px-5 pb-3 pt-1">
          {(["style", "gender", "format"] as const).map(group => (
            <fieldset key={group}>
              <legend className={legend}>{t(`home.filters.groups.${group}`)}</legend>
              <OptionChips options={GROUP_OPTIONS[group]} filters={filters} facets={facets} onToggle={onToggle} />
            </fieldset>
          ))}
          <fieldset>
            <legend className={legend}>{t("home.filters.groups.genres")}</legend>
            <OptionChips options={shownGenres} filters={filters} facets={facets} onToggle={onToggle}>
              {hiddenGenres > 0 && (
                <button type="button" onClick={() => setAllGenres(true)} className="inline-flex min-h-11 items-center gap-1 px-2 text-sm font-semibold text-wd-secondary">
                  {t("home.filters.more", { count: hiddenGenres })}<LuChevronDown size={14} aria-hidden />
                </button>
              )}
            </OptionChips>
          </fieldset>

          <div className="flex flex-col border-t border-wd-border">
            {(["worlds", "traits"] as const).map(group => (
              <div key={group} className="border-b border-wd-border">
                <button type="button" aria-expanded={openRow === group} onClick={() => setOpenRow(openRow === group ? null : group)}
                  className="flex min-h-[50px] w-full items-center justify-between gap-3 text-left text-[15px] font-semibold text-wd-text">
                  <span>{t(`home.filters.groups.${group}`)}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-wd-text-secondary">
                    <span className="truncate">{summary(group)}</span>
                    {openRow === group ? <LuChevronUp size={16} aria-hidden className="shrink-0" /> : <LuChevronRight size={16} aria-hidden className="shrink-0" />}
                  </span>
                </button>
                {openRow === group && <div className="pb-3"><OptionChips options={GROUP_OPTIONS[group]} filters={filters} facets={facets} onToggle={onToggle} /></div>}
              </div>
            ))}
            <AdultSwitch hideAdult={hideAdult} onChange={onHideAdultChange} />
          </div>
        </div>

        <div className="border-t border-wd-border px-5 pb-5 pt-3">
          <button type="button" onClick={onClose} className="min-h-[54px] w-full rounded-full bg-wd-primary text-base font-bold text-white transition-colors hover:bg-wd-primary-hover">
            {t("home.filters.show", { count: total })}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** Popovers close on an outside press or Escape. */
function useDismiss(active: boolean, onDismiss: () => void) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onDismiss(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [active, onDismiss]);
  return rootRef;
}

function SortMenu({ sort, onSortChange, className = "" }: { sort: CharacterSort; onSortChange: (sort: CharacterSort) => void; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useDismiss(open, () => setOpen(false));
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={`${t("home.sort")}: ${t(SORT_LABEL_KEYS[sort])}`} onClick={() => setOpen(current => !current)}
        className={`inline-flex items-center gap-1 text-sm font-semibold text-wd-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary ${className}`}>
        {t(SORT_LABEL_KEYS[sort])}<LuChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 min-w-40 overflow-hidden rounded-2xl border border-wd-border bg-wd-elevated py-1 shadow-wd">
          {CHARACTER_SORT_OPTIONS.map(option => (
            <button key={option.id} type="button" role="menuitemradio" aria-checked={sort === option.id}
              onClick={() => { setOpen(false); if (sort !== option.id) onSortChange(option.id); }}
              className={`flex min-h-11 w-full items-center px-4 text-left text-sm hover:bg-white/5 ${sort === option.id ? "font-semibold text-wd-text" : "text-wd-text-secondary"}`}>
              {t(SORT_LABEL_KEYS[option.id])}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type DesktopBarProps = {
  filters: CatalogFilters;
  facets: CatalogFacets | null;
  openGroup: GroupId | null;
  setOpenGroup: (group: GroupId | null) => void;
  hideAdult: boolean;
  onHideAdultChange: (hide: boolean) => void;
  onToggle: (option: CatalogFilterOption) => void;
  onReset: () => void;
  fallbackTotal: number;
};

/** Desktop: a row of drop-downs. A pill names the choice when there is one, otherwise the group. */
function DesktopFilterBar({ filters, facets, openGroup, setOpenGroup, hideAdult, onHideAdultChange, onToggle, onReset, fallbackTotal }: DesktopBarProps) {
  const { t } = useTranslation();
  const label = useOptionLabel();
  const rootRef = useDismiss(openGroup !== null, () => setOpenGroup(null));
  const pillText = (group: GroupId) => {
    const chosen = selectedCatalogOptions(filters).filter(option => option.group === group);
    if (!chosen.length) return t(`home.filters.groups.${group}`);
    return chosen.length === 1 ? label(chosen[0]) : `${t(`home.filters.groups.${group}`)} · ${chosen.length}`;
  };
  const total = facets?.total ?? fallbackTotal;
  return (
    <div ref={rootRef} role="group" aria-label={t("home.filters.button")} className="hidden flex-wrap items-center gap-2 md:flex">
      {GROUP_ORDER.map(group => {
        const hasValue = selectedCatalogOptions(filters).some(option => option.group === group);
        const open = openGroup === group;
        return (
          <div key={group} className="relative">
            <button type="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpenGroup(open ? null : group)}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary ${
                hasValue ? "bg-wd-text text-wd-bg" : "bg-wd-card text-[#d8d3e5] hover:text-white"
              }`}>
              {pillText(group)}{open ? <LuChevronUp size={14} aria-hidden /> : <LuChevronDown size={14} aria-hidden />}
            </button>
            {open && (
              <div className="absolute left-0 top-[52px] z-30 flex w-[400px] max-w-[80vw] flex-col gap-3.5 rounded-[20px] border border-wd-border bg-wd-elevated p-4 shadow-[0_24px_56px_rgba(0,0,0,0.6)]">
                <OptionChips options={GROUP_OPTIONS[group]} filters={filters} facets={facets} onToggle={onToggle} />
                <div className="flex items-center justify-end">
                  <button type="button" onClick={() => setOpenGroup(null)} className="min-h-11 rounded-full bg-wd-primary px-5 text-sm font-bold text-white transition-colors hover:bg-wd-primary-hover">
                    {t("home.filters.show", { count: total })}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <AdultSwitch hideAdult={hideAdult} onChange={onHideAdultChange} compact />
      {catalogFilterCount(filters) > 0 && (
        <button type="button" onClick={onReset} className="min-h-11 px-1.5 text-sm font-semibold text-wd-text-secondary hover:text-white">{t("home.filters.resetAll")}</button>
      )}
    </div>
  );
}

type CharacterSearchFiltersProps = {
  search: string;
  onSearchChange: (value: string) => void;
  sort: CharacterSort;
  onSortChange: (sort: CharacterSort) => void;
  filters: CatalogFilters;
  onFiltersChange: (filters: CatalogFilters) => void;
  hideAdult: boolean;
  onHideAdultChange: (hide: boolean) => void;
  total: number;
  loading: boolean;
  onPick?: () => void;
};

export default function CharacterSearchFilters({
  search, onSearchChange, sort, onSortChange, filters, onFiltersChange, hideAdult, onHideAdultChange, total, loading, onPick,
}: CharacterSearchFiltersProps) {
  const { t } = useTranslation();
  const locale = useCurrentLocale();
  const label = useOptionLabel();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<GroupId | null>(null);
  const facets = useCatalogFacets(sheetOpen || openGroup !== null, catalogFiltersQuery(filters), search, hideAdult);
  const selected = selectedCatalogOptions(filters);
  const badge = selected.length + (hideAdult ? 1 : 0);
  const searchPlaceholder = t("home.searchPlaceholder");
  const toggle = (option: CatalogFilterOption) => onFiltersChange(toggleCatalogOption(filters, option));
  const reset = () => onFiltersChange(EMPTY_CATALOG_FILTERS);

  return (
    <section className="relative z-30 mb-1 flex w-full shrink-0 flex-col gap-2.5 px-4 pt-3 md:mb-3 md:gap-3 md:px-6 md:pt-4">
      <div className="flex items-center gap-2 md:gap-2.5">
        <div className="relative min-w-0 flex-1 md:max-w-xl">
          <FaSearch aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm text-wd-text-secondary" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-12 w-full rounded-full border border-wd-border bg-wd-card py-0 pl-10 pr-10 text-[15px] text-white outline-none transition-colors placeholder:text-wd-text-secondary focus:border-wd-secondary/60 [&::-webkit-search-cancel-button]:hidden"
          />
          {search.trim().length > 0 && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              className="absolute right-1.5 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-wd-text-secondary transition-colors hover:bg-white/10 hover:text-white"
              aria-label={t("home.resetSearch")}
              title={t("home.resetSearch")}
            >
              <FaTimes aria-hidden className="text-xs" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
          className={`inline-flex h-12 shrink-0 items-center gap-1.5 rounded-full border pl-3.5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary md:hidden ${
            badge ? "border-wd-secondary/60 bg-wd-secondary/12 pr-2.5" : "border-wd-border bg-wd-card pr-3.5"
          }`}
        >
          <FaSlidersH aria-hidden className="text-sm" />
          {t("home.filters.button")}
          {badge > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-wd-secondary px-1 text-xs font-bold text-wd-on-secondary">{badge}</span>}
        </button>
        {onPick && (
          <button type="button" onClick={onPick} className="hidden h-12 shrink-0 items-center gap-1.5 rounded-full border border-wd-secondary/50 bg-wd-secondary/12 px-4 text-sm font-semibold text-wd-secondary transition-colors hover:bg-wd-secondary/20 md:inline-flex">
            <VerseCoinMark className="h-3 w-3" />{t("onboarding.catalog.pick")}
          </button>
        )}
        <div className="ml-auto hidden md:block">
          <SortMenu sort={sort} onSortChange={onSortChange} className="h-12 rounded-full border border-wd-border bg-wd-card px-4" />
        </div>
      </div>

      <DesktopFilterBar filters={filters} facets={facets} openGroup={openGroup} setOpenGroup={setOpenGroup} hideAdult={hideAdult}
        onHideAdultChange={onHideAdultChange} onToggle={toggle} onReset={reset} fallbackTotal={total} />

      {selected.length > 0 ? (
        <div role="group" aria-label={t("home.filters.selected")} className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden">
          {selected.map(option => (
            <button key={catalogOptionKey(option)} type="button" onClick={() => toggle(option)} aria-label={t("home.filters.removeLabel", { label: label(option) })}
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full bg-wd-text pl-3.5 pr-2.5 text-sm font-semibold text-wd-bg">
              {label(option)}<LuX size={14} aria-hidden />
            </button>
          ))}
        </div>
      ) : (
        <div role="group" aria-label={t("home.genresLabel")} className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden">
          {onPick && (
            <button type="button" onClick={onPick} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-wd-secondary/50 bg-wd-secondary/12 px-3.5 text-sm font-semibold text-wd-secondary">
              <VerseCoinMark className="h-3 w-3" />{t("home.filters.pick")}
            </button>
          )}
          {CATALOG_QUICK_GENRES.map(id => {
            const tag = CATALOG_GENRE_TAGS[id];
            const featured = FEATURED_GENRES.find(genre => genre.tag === tag);
            // Crawlers follow the href to the genre page; a plain click filters in place.
            return (
              <a key={id} href={featured ? withLocale(genrePath(featured.id), locale) : undefined}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  toggle({ group: "genres", id });
                }}
                className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-wd-card px-4 text-sm font-semibold text-[#d8d3e5] transition-colors hover:text-white">
                {label({ group: "genres", id })}
              </a>
            );
          })}
        </div>
      )}

      <div className="flex min-h-9 items-center justify-between gap-3">
        <p aria-live="polite" className="text-sm text-wd-text-secondary">
          {loading ? " " : t("home.filters.resultCount", { count: total })}
        </p>
        <div className="flex items-center gap-3.5 md:hidden">
          {selected.length > 0 && (
            <button type="button" onClick={reset} className="min-h-9 text-sm font-semibold text-wd-text-secondary hover:text-white">{t("home.filters.reset")}</button>
          )}
          <SortMenu sort={sort} onSortChange={onSortChange} className="min-h-9" />
        </div>
      </div>

      {sheetOpen && (
        <FiltersSheet filters={filters} facets={facets} hideAdult={hideAdult} onHideAdultChange={onHideAdultChange}
          onToggle={toggle} onReset={reset} onClose={() => setSheetOpen(false)} fallbackTotal={total} />
      )}
    </section>
  );
}

export function CatalogEmptyFilters({ filters, search, hideAdult, onFiltersChange, createHref }: {
  filters: CatalogFilters; search: string; hideAdult: boolean; onFiltersChange: (filters: CatalogFilters) => void; createHref: string;
}) {
  const { t } = useTranslation();
  const label = useOptionLabel();
  const facets = useCatalogFacets(true, catalogFiltersQuery(filters), search, hideAdult);
  const suggestions = selectedCatalogOptions(filters)
    .map(option => ({ option, count: facets?.without[catalogOptionKey(option)] ?? 0 }))
    .filter(item => item.count > 0)
    .sort((a, b) => a.count - b.count)
    .slice(0, 3);
  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-4 py-8">
      <div className="flex flex-col gap-2">
        <h3 className="font-display text-[22px] font-semibold leading-tight text-wd-text">{t("home.filters.emptyTitle")}</h3>
        <p className="text-[15px] leading-relaxed text-wd-text-secondary">{t("home.filters.emptyText")}</p>
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-col gap-2">
          {suggestions.map(({ option, count }) => (
            <button key={catalogOptionKey(option)} type="button" onClick={() => onFiltersChange(toggleCatalogOption(filters, option))}
              className="flex min-h-14 items-center justify-between gap-3 rounded-2xl bg-wd-card px-4 text-left text-[15px] font-semibold text-wd-text transition-colors hover:bg-bg-card-hover">
              {t("home.filters.removeSuggestion", { label: label(option) })}
              <span className="shrink-0 text-sm font-medium text-wd-text-secondary">{t("home.filters.resultCount", { count })}</span>
            </button>
          ))}
        </div>
      )}
      <a href={createHref} className="flex min-h-[52px] items-center justify-center rounded-full bg-wd-primary text-[15px] font-bold text-white transition-colors hover:bg-wd-primary-hover">{t("header.menu.create")}</a>
      <button type="button" onClick={() => onFiltersChange(EMPTY_CATALOG_FILTERS)}
        className="min-h-11 text-sm font-semibold text-wd-text-secondary hover:text-white">{t("home.filters.resetAll")}</button>
    </section>
  );
}
