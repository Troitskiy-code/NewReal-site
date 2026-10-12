"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import axios from "axios";
import { useSession } from "next-auth/react";
import { useCharactersPageLimit } from "@/hooks/useCharactersPageLimit";
import {
  characterReturnMatches,
  readCharacterReturn,
  rememberCharacterListState,
  restoreCharacterScroll,
} from "@/lib/characterReturn";

function scrollCharacterListToTop() {
  const node = document.querySelector("[data-character-list-scroll]");
  if (node instanceof HTMLElement) {
    node.scrollTo({ top: 0 });
  }
}

export function usePaginatedCharacters({ sort, listKey, page, setPage, initialData, onSearchChange }) {
  const { data: session, status } = useSession();
  const accountKey = status === "loading" ? (initialData?.viewerId ?? "guest") : (session?.user?.id ?? "guest");
  // A cached/navigation server snapshot can belong to a different session.
  const initialAccount = initialData ? (initialData.viewerId ?? "guest") : accountKey;
  const [loadedAccount, setLoadedAccount] = useState(initialAccount);
  const [recommendationMode, setRecommendationMode] = useState(initialData?.meta.recommendationMode ?? null);
  const activeRequest = useRef({ generation: 0, controller: null });
  const limit = useCharactersPageLimit(initialData?.meta.limit ?? null);
  const [search, setSearch] = useState(initialData?.search ?? "");
  const [characters, setCharacters] = useState(initialData?.data ?? []);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState(null);
  const [total, setTotal] = useState(initialData?.meta.total ?? 0);
  const [totalPages, setTotalPages] = useState(initialData?.meta.totalPages ?? 0);
  const [ready, setReady] = useState(false);
  const skipFetchRef = useRef(false);
  const lastQueryRef = useRef(initialData ? `${initialAccount}\0${sort}\0${initialData.search}\0${page}\0${initialData.meta.limit}` : "");

  useLayoutEffect(() => {
    // Browser-only return state is restored after hydration; never replace the
    // server snapshot during render or synchronously cascade layout updates.
    const frame = requestAnimationFrame(() => {
      const snapshot = readCharacterReturn();
      if (sort === "for-you" && characterReturnMatches(snapshot, listKey, sort, accountKey)) {
        restoreCharacterScroll(snapshot);
      }
      if (sort !== "for-you" && characterReturnMatches(snapshot, listKey, sort, accountKey) && Array.isArray(snapshot.characters)) {
        const restoredSearch = snapshot.search ?? "";
        setSearch(restoredSearch);
        setCharacters(snapshot.characters);
        setLoadedAccount(accountKey);
        setTotal(snapshot.total ?? snapshot.characters.length);
        setTotalPages(snapshot.totalPages ?? 0);
        setLoading(false);
        skipFetchRef.current = true;
        if (snapshot.page && snapshot.page !== page) {
          setPage(snapshot.page);
        }
      }
      setReady(true);
    });
    return () => cancelAnimationFrame(frame);
    // Restore against the sort from the first paint (URL).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, accountKey]);

  const fetchCharacters = useCallback(
    async (pageNum, pageLimit, { scrollToTop = false } = {}) => {
      activeRequest.current.controller?.abort();
      const controller = new AbortController();
      const generation = activeRequest.current.generation + 1;
      activeRequest.current = { generation, controller };
      const current = () => !controller.signal.aborted && activeRequest.current.generation === generation;
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams();
        params.set("page", String(pageNum));
        params.set("limit", String(pageLimit));
        params.set("sort", sort);
        if (search.trim()) params.set("search", search.trim());

        const { data } = await axios.get(`/api/characters?${params.toString()}`, { signal: controller.signal });
        if (!current()) return;
        const nextTotalPages = Number(data.meta.totalPages) || 0;
        const nextPage = Number(data.meta.page) || pageNum;

        setCharacters(data.data);
        setLoadedAccount(accountKey);
        setRecommendationMode(data.meta.recommendationMode ?? null);
        setTotal(Number(data.meta.total) || 0);
        setTotalPages(nextTotalPages);

        if (nextTotalPages > 0 && nextPage > nextTotalPages) {
          setPage(nextTotalPages);
        }

        if (scrollToTop) {
          scrollCharacterListToTop();
        }
      } catch (err) {
        if (!current() || axios.isCancel(err)) return;
        const message =
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : "Не удалось загрузить персонажей";
        setError(message);
        setCharacters([]);
        setLoadedAccount(accountKey);
        setRecommendationMode(null);
      } finally {
        if (current()) setLoading(false);
      }
    },
    [search, setPage, sort, accountKey]
  );

  useEffect(() => () => { activeRequest.current.controller?.abort(); }, [accountKey]);

  useEffect(() => {
    if (!ready || limit == null) return;

    const queryKey = `${accountKey}\0${sort}\0${search}\0${page}\0${limit}`;
    if (lastQueryRef.current === queryKey) return;

    if (skipFetchRef.current) {
      skipFetchRef.current = false;
      lastQueryRef.current = queryKey;
      restoreCharacterScroll(readCharacterReturn());
      return;
    }

    const shouldScroll = lastQueryRef.current !== "";
    lastQueryRef.current = queryKey;
    fetchCharacters(page, limit, { scrollToTop: shouldScroll });
  }, [fetchCharacters, limit, page, ready, search, sort, accountKey]);

  useEffect(() => {
    if (!ready || loading || loadedAccount !== accountKey) return;
    rememberCharacterListState({
      listKey,
      search,
      sort,
      characters,
      page,
      hasMore: page < totalPages,
      total,
      totalPages,
      viewerId: accountKey,
    });
  }, [ready, loading, listKey, search, sort, characters, page, total, totalPages, accountKey, loadedAccount]);

  const goToPage = useCallback(
    (nextPage) => {
      const safePage = Math.max(1, Math.trunc(nextPage) || 1);
      if (safePage === page) return;
      setPage(safePage);
    },
    [page, setPage]
  );

  const handleSearchChange = useCallback(
    (value) => {
      setSearch(value);
      if (onSearchChange) onSearchChange(value);
      else if (page !== 1) setPage(1);
    },
    [onSearchChange, page, setPage]
  );

  const reload = useCallback(() => {
    if (limit == null) return;
    lastQueryRef.current = "";
    fetchCharacters(page, limit);
  }, [fetchCharacters, limit, page]);

  return {
    search,
    setSearch: handleSearchChange,
    characters: loadedAccount === accountKey ? characters : [],
    recommendationMode: loadedAccount === accountKey ? recommendationMode : null,
    loading: loading || limit == null || loadedAccount !== accountKey,
    loadingMore: false,
    error,
    page,
    hasMore: page < totalPages,
    total,
    totalPages,
    goToPage,
    loadMore: () => goToPage(page + 1),
    reload,
  };
}
