"use client";

import LocaleLink from "@/components/LocaleLink";
import Footer from "@/components/Footer";
import CharacterCard from "@/components/CharacterCard";
import CharacterSearchFilters from "@/components/CharacterSearchFilters";
import CharacterPagination from "@/components/CharacterPagination";
import HomeHero from "@/components/HomeHero";
import ContinueStoryCard from "@/components/ContinueStoryCard";
import FirstStepOnboarding, { writeOnboardingCookie } from "@/components/FirstStepOnboarding";
import { hasOnboardingSignals } from "@/lib/onboarding";
import { useState } from "react";
import { FaUser } from "react-icons/fa";
import { useCharacterSortUrl } from "@/hooks/useCharacterSortUrl";
import { usePaginatedCharacters } from "@/hooks/usePaginatedCharacters";
import { useTranslation } from "react-i18next";
import { withLocale } from "@/lib/i18nConfig";

// The widest grid row up to lg (4 columns); on xl the fifth card is in view and loads at once anyway.
const FIRST_ROW_CARDS = 4;

export default function HomePageContent({ initialData, showHero = false, onboarding = null, freeQuotaOffer = false }) {
  const { t, i18n } = useTranslation();
  const { sort, setSort, page, setPage, setSearchQuery } = useCharacterSortUrl();
  const { search, setSearch, characters, loading, error, total, totalPages, goToPage, reload, recommendationMode } =
    usePaginatedCharacters({ sort, page, setPage, listKey: "home", initialData, onSearchChange: setSearchQuery });

  const [onboardingSource, setOnboardingSource] = useState(onboarding?.show ? "organic" : null);
  const [onboardingPrefs, setOnboardingPrefs] = useState(onboarding?.prefs ?? null);
  const openOnboarding = onboarding?.enabled ? (source) => setOnboardingSource(source) : undefined;
  const updatePrefs = (prefs) => { writeOnboardingCookie(prefs); setOnboardingPrefs(prefs); reload(); };

  const hasFilters = search.trim().length > 0;
  const sectionTitle = t(hasFilters ? "home.sectionTitle.search" : sort === "for-you" && recommendationMode !== "personalized" ? "home.recommendations.discoveryTitle" : `home.sectionTitle.${sort}`);

  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-wd-bg text-wd-text">
      {showHero ? (
        <HomeHero total={initialData?.meta.total ?? total} characters={initialData?.data ?? []}
          onStart={openOnboarding ? () => openOnboarding("hero") : undefined} freeQuotaOffer={freeQuotaOffer} />
      ) : (
        <>
          {/* Signed-in visitors land on their latest story; the catalog title stays as a quiet h1. */}
          <ContinueStoryCard />
          <h1 className="px-4 pt-5 text-[13px] font-semibold text-wd-text-secondary md:px-6">{t("meta.home.title")}</h1>
        </>
      )}

      <CharacterSearchFilters
        search={search}
        onSearchChange={setSearch}
        sort={sort}
        onSortChange={setSort}
      />

      <main
        id="catalog"
        data-character-list-scroll
        className="flex min-h-0 flex-1 scroll-mt-24 flex-col gap-4 overflow-y-auto px-4 pb-6 pt-2 scrollbar-subtle md:gap-5 md:px-6"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-base font-semibold text-wd-text md:text-xl">{sectionTitle}</h2>
          {!loading && total > 0 && (
            <p className="shrink-0 text-[13px] text-wd-text-secondary">
              {t("home.found")}<span className="font-semibold text-white">{total}</span>
            </p>
          )}
        </div>

        {onboarding?.enabled && sort === "for-you" && hasOnboardingSignals(onboardingPrefs) ? (
          <OnboardingPrefsBar prefs={onboardingPrefs} onChange={updatePrefs} onPickAgain={() => openOnboarding("reopen")} />
        ) : onboarding?.enabled && !hasFilters && (
          <button type="button" onClick={() => openOnboarding("reopen")}
            className="inline-flex items-center gap-1.5 self-start rounded-full border border-wd-secondary/60 bg-wd-secondary/15 px-3.5 py-2 text-[13px] font-semibold text-wd-secondary-text transition-colors hover:bg-wd-secondary/25">
            <span aria-hidden>✦</span>{t("onboarding.catalog.pick")}
          </button>
        )}

        {sort === "for-you" && !loading && !error && <p className="text-sm leading-relaxed text-wd-text-secondary">
          {t(recommendationMode === "personalized" ? "home.recommendations.personalizedHint" : "home.recommendations.discoveryHint")}
        </p>}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
          </div>
        ) : error ? (
          <div className="rounded-wd border border-wd-primary/30 bg-wd-card p-10 text-center shadow-wd">
            <p className="text-sm font-semibold text-wd-primary-soft">{t("common.error")}</p>
            <p className="mx-auto mt-2 max-w-xs text-xs text-wd-text-secondary">{error}</p>
            <button type="button" onClick={reload} className="wd-button mt-4 px-5 py-2.5 text-xs">
              {t("common.retry")}
            </button>
          </div>
        ) : characters.length === 0 ? (
          <div className="rounded-wd border border-wd-border bg-wd-card p-10 text-center shadow-wd">
            <FaUser className="mx-auto mb-4 text-4xl opacity-20" />
            <h3 className="text-sm font-semibold text-white">{t("home.noCharacters")}</h3>
            <p className="mx-auto mt-2 max-w-xs text-xs text-wd-text-secondary">
              {hasFilters ? t("home.noResults") : t("home.noPublished")}
            </p>
            {!hasFilters && (
              <LocaleLink href="/create" className="wd-button mt-4 inline-flex px-5 py-2.5 text-xs">
                {t("header.menu.create")}
              </LocaleLink>
            )}
          </div>
        ) : (
          <>
            <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-3 md:gap-4 lg:grid-cols-4 xl:grid-cols-5 xl:gap-5">
              {characters.map((character, index) => (
                <CharacterCard key={character.id} character={character} eager={index < FIRST_ROW_CARDS}
                  onFavoriteChange={sort === "for-you" ? reload : undefined} />
              ))}
            </div>

            <CharacterPagination
              page={page}
              totalPages={totalPages}
              onPageChange={goToPage}
              disabled={loading}
              hrefForPage={(target) => `${withLocale("/", i18n.language === "en" ? "en" : "ru")}?${new URLSearchParams({ sort, page: String(target), ...(search ? { q: search } : {}) })}`}
            />
          </>
        )}
      </main>

      <Footer />

      {onboardingSource && (
        <FirstStepOnboarding source={onboardingSource} initialPrefs={onboardingSource === "organic" ? null : onboardingPrefs}
          onClose={(prefs) => {
            setOnboardingSource(null);
            setOnboardingPrefs(prefs);
            if (sort === "for-you") reload();
          }} />
      )}
    </div>
  );
}

function OnboardingPrefsBar({ prefs, onChange, onPickAgain }) {
  const { t } = useTranslation();
  const chips = [
    ...(prefs.style === "anime" || prefs.style === "realistic"
      ? [{ key: "style", label: t(`onboarding.styleLabel.${prefs.style}`), next: { ...prefs, style: null } }] : []),
    ...prefs.interests.map((id) => ({ key: id, label: t(`onboarding.interest.${id}.label`), next: { ...prefs, interests: prefs.interests.filter((item) => item !== id) } })),
    ...(prefs.gender ? [{ key: "gender", label: t(prefs.gender === "male" ? "onboarding.interests.genderMale" : "onboarding.interests.genderFemale"), next: { ...prefs, gender: null } }] : []),
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] text-wd-text-secondary">{t("onboarding.catalog.applied")}:</span>
      {chips.map((chip) => (
        <span key={chip.key} className="inline-flex items-center gap-1 rounded-full border border-wd-primary/50 bg-wd-primary/15 py-1 pl-3 pr-1 text-[12.5px] font-semibold text-rose-100">
          {chip.label}
          <button type="button" onClick={() => onChange(chip.next)} aria-label={t("onboarding.catalog.remove", { label: chip.label })}
            className="grid h-6 w-6 place-items-center rounded-full text-sm leading-none text-rose-100/70 hover:bg-white/10 hover:text-white">×</button>
        </span>
      ))}
      <button type="button" onClick={onPickAgain} className="rounded-full px-2 py-1 text-[13px] font-semibold text-wd-secondary-text hover:underline">
        {t("onboarding.catalog.pickAgain")}
      </button>
    </div>
  );
}
