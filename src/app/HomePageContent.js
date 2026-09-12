"use client";

import LocaleLink from "@/components/LocaleLink";
import Footer from "@/components/Footer";
import CharacterCard from "@/components/CharacterCard";
import CharacterSearchFilters from "@/components/CharacterSearchFilters";
import CharacterPagination from "@/components/CharacterPagination";
import { FaUser } from "react-icons/fa";
import { useCharacterSortUrl } from "@/hooks/useCharacterSortUrl";
import { usePaginatedCharacters } from "@/hooks/usePaginatedCharacters";
import { useTranslation } from "react-i18next";

export default function HomePageContent() {
  const { t } = useTranslation();
  const { sort, setSort, page, setPage } = useCharacterSortUrl();
  const { search, setSearch, characters, loading, error, total, totalPages, goToPage, reload } =
    usePaginatedCharacters({ sort, page, setPage, listKey: "home" });

  const hasFilters = search.trim().length > 0;

  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-[#121212] text-wd-text">

      <CharacterSearchFilters
        search={search}
        onSearchChange={setSearch}
        sort={sort}
        onSortChange={setSort}
      />

      <main data-character-list-scroll className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-6 pt-2 scrollbar-subtle md:gap-6 md:px-6 md:pt-4">
        {!loading && total > 0 && (
          <p className="text-xs text-wd-text-secondary">
            {t("home.found")}<span className="font-bold text-white">{total}</span>
          </p>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
          </div>
        ) : error ? (
          <div className="rounded-wd border border-wd-primary/30 bg-wd-card p-10 text-center shadow-wd">
            <p className="text-sm font-extrabold uppercase text-wd-primary">{t("common.error")}</p>
            <p className="mx-auto mt-2 max-w-xs text-xs text-wd-text-secondary">{error}</p>
            <button type="button" onClick={reload} className="wd-button mt-4 px-5 py-2.5 text-xs">
              {t("common.retry")}
            </button>
          </div>
        ) : characters.length === 0 ? (
          <div className="rounded-wd border border-wd-border bg-wd-card p-10 text-center shadow-wd">
            <FaUser className="mx-auto mb-4 text-4xl opacity-20" />
            <h3 className="text-sm font-extrabold uppercase text-white">{t("home.noCharacters")}</h3>
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
            <div className="grid w-full grid-cols-2 gap-4 md:grid-cols-3 md:gap-5 lg:grid-cols-4 lg:gap-6 xl:grid-cols-5">
              {characters.map((character) => (
                <CharacterCard key={character.id} character={character} />
              ))}
            </div>

            <CharacterPagination
              page={page}
              totalPages={totalPages}
              onPageChange={goToPage}
              disabled={loading}
            />
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
