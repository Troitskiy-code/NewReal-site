"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import Footer from "@/components/Footer";
import CharacterCard from "@/components/CharacterCard";
import CharacterSearchFilters from "@/components/CharacterSearchFilters";
import { Toaster } from "react-hot-toast";
import { FaUser } from "react-icons/fa";
import { useCharacterSortUrl } from "@/hooks/useCharacterSortUrl";
import { usePaginatedCharacters } from "@/hooks/usePaginatedCharacters";

function HomePageContent() {
  const { sort, setSort } = useCharacterSortUrl();
  const [search, setSearch] = useState("");
  const { characters, loading, loadingMore, error, hasMore, total, loadMore, reload } =
    usePaginatedCharacters({ search, sort });

  const hasFilters = search.trim().length > 0;

  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-[#121212] text-wd-text">
      <Toaster position="top-right" />

      <CharacterSearchFilters
        search={search}
        onSearchChange={setSearch}
        sort={sort}
        onSortChange={setSort}
      />

      <main className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-6 pt-2 scrollbar-subtle md:gap-6 md:px-6 md:pt-4">
        {!loading && total > 0 && (
          <p className="text-xs text-wd-text-secondary">
            Найдено персонажей: <span className="font-bold text-white">{total}</span>
          </p>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
          </div>
        ) : error ? (
          <div className="rounded-wd border border-wd-primary/30 bg-wd-card p-10 text-center shadow-wd">
            <p className="text-sm font-extrabold uppercase text-wd-primary">Ошибка</p>
            <p className="mx-auto mt-2 max-w-xs text-xs text-wd-text-secondary">{error}</p>
            <button type="button" onClick={reload} className="wd-button mt-4 px-5 py-2.5 text-xs">
              Повторить
            </button>
          </div>
        ) : characters.length === 0 ? (
          <div className="rounded-wd border border-wd-border bg-wd-card p-10 text-center shadow-wd">
            <FaUser className="mx-auto mb-4 text-4xl opacity-20" />
            <h3 className="text-sm font-extrabold uppercase text-white">Нет персонажей</h3>
            <p className="mx-auto mt-2 max-w-xs text-xs text-wd-text-secondary">
              {hasFilters
                ? "По вашему запросу ничего не найдено. Попробуйте изменить фильтры."
                : "Пока нет опубликованных персонажей. Создайте первого!"}
            </p>
            {!hasFilters && (
              <Link href="/create" className="wd-button mt-4 inline-flex px-5 py-2.5 text-xs">
                Создать персонажа
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className="grid w-full grid-cols-2 gap-4 md:grid-cols-3 md:gap-5 lg:grid-cols-4 lg:gap-6 xl:grid-cols-5">
              {characters.map((character) => (
                <CharacterCard key={character.id} character={character} />
              ))}
            </div>

            {hasMore && (
              <div className="flex justify-center pb-6 pt-2">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="rounded-wd-pill border border-wd-border bg-wd-card px-8 py-3 text-xs font-bold text-white shadow-wd transition-all hover:border-wd-secondary disabled:opacity-50"
                >
                  {loadingMore ? "Загрузка..." : "Загрузить ещё"}
                </button>
              </div>
            )}
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-[#121212]">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
        </div>
      }
    >
      <HomePageContent />
    </Suspense>
  );
}
