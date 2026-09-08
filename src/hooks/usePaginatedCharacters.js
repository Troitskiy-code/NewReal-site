"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import axios from "axios";
import { CHARACTERS_PAGE_LIMIT } from "@/lib/charactersList";
import {
  characterReturnMatches,
  readCharacterReturn,
  rememberCharacterListState,
  restoreCharacterScroll,
} from "@/lib/characterReturn";

export function usePaginatedCharacters({ sort, listKey }) {
  const [search, setSearch] = useState("");
  const [characters, setCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [ready, setReady] = useState(false);
  const skipFetchRef = useRef(false);
  const restoredQueryRef = useRef(null);

  useLayoutEffect(() => {
    const snapshot = readCharacterReturn();
    if (characterReturnMatches(snapshot, listKey, sort) && Array.isArray(snapshot.characters)) {
      const restoredSearch = snapshot.search ?? "";
      setSearch(restoredSearch);
      setCharacters(snapshot.characters);
      setPage(snapshot.page ?? 1);
      setHasMore(Boolean(snapshot.hasMore));
      setTotal(snapshot.total ?? snapshot.characters.length);
      setLoading(false);
      skipFetchRef.current = true;
      restoredQueryRef.current = `${sort}\0${restoredSearch}`;
    }
    setReady(true);
    // Restore against the sort from the first paint (URL).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);

  const fetchCharacters = useCallback(
    async (pageNum, append) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setError(null);
      }

      try {
        const params = new URLSearchParams();
        params.set("page", String(pageNum));
        params.set("limit", String(CHARACTERS_PAGE_LIMIT));
        params.set("sort", sort);
        if (search.trim()) params.set("search", search.trim());

        const { data } = await axios.get(`/api/characters?${params.toString()}`);

        setCharacters((prev) => (append ? [...prev, ...data.data] : data.data));
        setTotal(data.meta.total);
        setHasMore(data.meta.page < data.meta.totalPages);
        setPage(data.meta.page);
      } catch (err) {
        const message =
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : "Не удалось загрузить персонажей";
        setError(message);
        if (!append) setCharacters([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [search, sort]
  );

  useEffect(() => {
    if (!ready) return;
    if (skipFetchRef.current) {
      skipFetchRef.current = false;
      restoreCharacterScroll(readCharacterReturn());
      return;
    }
    if (restoredQueryRef.current === `${sort}\0${search}`) {
      restoredQueryRef.current = null;
      restoreCharacterScroll(readCharacterReturn());
      return;
    }
    restoredQueryRef.current = null;
    setPage(1);
    fetchCharacters(1, false);
  }, [ready, fetchCharacters, search, sort]);

  useEffect(() => {
    if (!ready || loading) return;
    rememberCharacterListState({
      listKey,
      search,
      sort,
      characters,
      page,
      hasMore,
      total,
    });
  }, [ready, loading, listKey, search, sort, characters, page, hasMore, total]);

  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore) {
      fetchCharacters(page + 1, true);
    }
  }, [fetchCharacters, hasMore, loadingMore, page]);

  const reload = useCallback(() => {
    setPage(1);
    fetchCharacters(1, false);
  }, [fetchCharacters]);

  return {
    search,
    setSearch,
    characters,
    loading,
    loadingMore,
    error,
    page,
    hasMore,
    total,
    loadMore,
    reload,
  };
}
