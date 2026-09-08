"use client";

import { Suspense } from "react";
import Link from "next/link";
import Footer from "@/components/Footer";
import CharacterCard from "@/components/CharacterCard";
import CharacterSearchFilters from "@/components/CharacterSearchFilters";
import { Toaster } from "react-hot-toast";
import { FaUser, FaPlus } from "react-icons/fa";
import { useCharacterSortUrl } from "@/hooks/useCharacterSortUrl";
import { usePaginatedCharacters } from "@/hooks/usePaginatedCharacters";

function GalleryPageContent() {
  const { sort, setSort } = useCharacterSortUrl();
  const { search, setSearch, characters, loading, loadingMore, error, hasMore, total, loadMore, reload } =
    usePaginatedCharacters({ sort, listKey: "gallery" });

  const hasFilters = search.trim().length > 0;

  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-[#121212] select-none text-wd-text">
      <Toaster position="top-right" />

      <div className="mb-2 w-full border-b border-[#2A2A2A] px-4 py-3 md:mb-0 md:py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h1 className="text-xl font-black uppercase tracking-tight text-white md:text-2xl lg:text-3xl">
              Галерея персонажей
            </h1>
            <p className="text-xs text-wd-text-secondary">
              Просматривайте опубликованных персонажей сообщества
              {!loading && total > 0 && ` · ${total} найдено`}
            </p>
          </div>
          <Link
            href="/create"
            className="wd-button inline-flex shrink-0 items-center justify-center gap-2 px-5 py-2.5 text-xs"
          >
            <FaPlus className="text-[10px]" />
            Создать персонажа
          </Link>
        </div>
      </div>

      <CharacterSearchFilters
        search={search}
        onSearchChange={setSearch}
        sort={sort}
        onSortChange={setSort}
      />

      <main data-character-list-scroll className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-6 pt-2 scrollbar-subtle md:gap-6 md:px-6 md:pt-4">
        {loading ? (
          <div className="flex flex-1 items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center rounded border border-red-500/30 bg-bg-card/20 py-20 text-center">
            <p className="text-sm font-extrabold uppercase text-red-500">Ошибка</p>
            <p className="mt-2 max-w-xs text-xs text-secondary-text">{error}</p>
            <button
              type="button"
              onClick={reload}
              className="mt-4 rounded-full bg-primary px-5 py-2 text-xs font-bold text-white transition-all hover:bg-primary-hover"
            >
              Повторить
            </button>
          </div>
        ) : characters.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center rounded border border-divider/30 bg-bg-card/20 py-20 text-center">
            <FaUser className="mb-4 text-4xl opacity-20" />
            <h3 className="text-sm font-extrabold uppercase">Нет персонажей</h3>
            <p className="mt-2 max-w-xs text-xs text-secondary-text">
              {hasFilters
                ? "По вашему запросу ничего не найдено. Попробуйте изменить фильтры."
                : "Пока нет опубликованных персонажей. Создайте первого!"}
            </p>
            {!hasFilters && (
              <Link
                href="/create"
                className="mt-4 rounded-full bg-primary px-5 py-2.5 text-xs font-bold text-white transition-all hover:bg-primary-hover"
              >
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
                  className="rounded-wd-pill border border-wd-border bg-wd-card px-6 py-3 text-xs font-bold text-white transition-all hover:border-wd-secondary disabled:opacity-50"
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

export default function GalleryPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-[#121212]">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
        </div>
      }
    >
      <GalleryPageContent />
    </Suspense>
  );
}
