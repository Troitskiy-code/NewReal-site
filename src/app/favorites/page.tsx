"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import Footer from "@/components/Footer";
import CharacterCard from "@/components/CharacterCard";
import { Toaster } from "react-hot-toast";
import { FaHeart, FaUser } from "react-icons/fa";
import axios from "axios";

type Character = {
  id: string;
  name: string;
  description: string | null;
  descriptionCard?: string | null;
  appearance: string | null;
  tags: string | null;
  imageUrl: string | null;
  isPublic: boolean;
  totalMessages?: number;
  isFavorited?: boolean;
};

type FavoritesResponse = {
  data: Character[];
};

function FavoritesPageContent() {
  const { status } = useSession();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadFavorites = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.get<FavoritesResponse>("/api/favorites");
      setCharacters(data.data);
    } catch {
      setError("Не удалось загрузить избранное");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      loadFavorites();
    } else if (status === "unauthenticated") {
      setLoading(false);
    }
  }, [status, loadFavorites]);

  const handleFavoriteChange = (characterId: string, isFavorited: boolean) => {
    if (!isFavorited) {
      setCharacters((prev) => prev.filter((character) => character.id !== characterId));
    }
  };

  if (status === "loading" || loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#121212]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="flex min-h-dvh flex-col bg-[#121212] text-wd-text">
        <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12 text-center">
          <FaHeart className="text-4xl text-wd-primary opacity-30" />
          <h1 className="text-xl font-black uppercase tracking-tight text-white">Избранное</h1>
          <p className="max-w-sm text-xs text-wd-text-secondary">
            Войдите в аккаунт, чтобы сохранять персонажей в избранное.
          </p>
          <Link href="/login" className="wd-button px-6 py-2.5 text-sm">
            Войти
          </Link>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-[#121212] text-wd-text">
      <Toaster position="top-right" />

      <div className="mb-2 w-full border-b border-[#2A2A2A] px-4 py-3 md:py-4">
        <div className="space-y-1">
          <h1 className="text-xl font-black uppercase tracking-tight text-white md:text-2xl">Избранное</h1>
          <p className="text-xs text-wd-text-secondary">
            Персонажи, которые вы добавили в избранное
            {!loading && characters.length > 0 && ` · ${characters.length}`}
          </p>
        </div>
      </div>

      <main className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-6 pt-2 scrollbar-subtle md:gap-6 md:px-6 md:pt-4">
        {error ? (
          <div className="rounded-wd border border-wd-primary/30 bg-wd-card p-10 text-center shadow-wd">
            <p className="text-sm font-extrabold uppercase text-wd-primary">Ошибка</p>
            <p className="mx-auto mt-2 max-w-xs text-xs text-wd-text-secondary">{error}</p>
            <button type="button" onClick={loadFavorites} className="wd-button mt-4 px-5 py-2.5 text-xs">
              Повторить
            </button>
          </div>
        ) : characters.length === 0 ? (
          <div className="rounded-wd border border-wd-border bg-wd-card p-10 text-center shadow-wd">
            <FaHeart className="mx-auto mb-4 text-4xl opacity-20" />
            <h3 className="text-sm font-extrabold uppercase text-white">Нет избранных персонажей</h3>
            <p className="mx-auto mt-2 max-w-xs text-xs text-wd-text-secondary">
              Нажмите на звёздочку на карточке персонажа, чтобы добавить его сюда.
            </p>
            <Link href="/" className="wd-button mt-4 inline-flex px-5 py-2.5 text-xs">
              На главную
            </Link>
          </div>
        ) : (
          <div className="grid w-full grid-cols-2 gap-4 md:grid-cols-3 md:gap-5 lg:grid-cols-4 lg:gap-6 xl:grid-cols-5">
            {characters.map((character) => (
              <CharacterCard
                key={character.id}
                character={character}
                onFavoriteChange={handleFavoriteChange}
              />
            ))}
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}

export default function FavoritesPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center bg-[#121212]">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
        </div>
      }
    >
      <FavoritesPageContent />
    </Suspense>
  );
}
