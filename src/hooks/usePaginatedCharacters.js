"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import axios from "axios";
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

export function usePaginatedCharacters({ sort, listKey, page, setPage }) {
  const limit = useCharactersPageLimit();
  const [search, setSearch] = useState("");
  const [characters, setCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [ready, setReady] = useState(false);
  const skipFetchRef = useRef(false);
  const lastQueryRef = useRef("");

  useLayoutEffect(() => {
    const snapshot = readCharacterReturn();
    if (characterReturnMatches(snapshot, listKey, sort) && Array.isArray(snapshot.characters)) {
      const restoredSearch = snapshot.search ?? "";
      setSearch(restoredSearch);
      setCharacters(snapshot.characters);
      setTotal(snapshot.total ?? snapshot.characters.length);
      setTotalPages(snapshot.totalPages ?? 0);
      setLoading(false);
      skipFetchRef.current = true;
      if (snapshot.page && snapshot.page !== page) {
        setPage(snapshot.page);
      }
    }
    setReady(true);
    // Restore against the sort from the first paint (URL).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);

  const fetchCharacters = useCallback(
    async (pageNum, pageLimit, { scrollToTop = false } = {}) => {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams();
        params.set("page", String(pageNum));
        params.set("limit", String(pageLimit));
        params.set("sort", sort);
        if (search.trim()) params.set("search", search.trim());

        const { data } = await axios.get(`/api/characters?${params.toString()}`);
        const nextTotalPages = Number(data.meta.totalPages) || 0;
        const nextPage = Number(data.meta.page) || pageNum;

        setCharacters(data.data);
        setTotal(Number(data.meta.total) || 0);
        setTotalPages(nextTotalPages);

        if (nextTotalPages > 0 && nextPage > nextTotalPages) {
          setPage(nextTotalPages);
        }

        if (scrollToTop) {
          scrollCharacterListToTop();
        }
      } catch (err) {
        const message =
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : "Не удалось загрузить персонажей";
        setError(message);
        setCharacters([]);
      } finally {
        setLoading(false);
      }
    },
    [search, setPage, sort]
  );

  useEffect(() => {
    if (!ready || limit == null) return;

    const queryKey = `${sort}\0${search}\0${page}\0${limit}`;
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
  }, [fetchCharacters, limit, page, ready, search, sort]);

  useEffect(() => {
    if (!ready || loading) return;
    rememberCharacterListState({
      listKey,
      search,
      sort,
      characters,
      page,
      hasMore: page < totalPages,
      total,
      totalPages,
    });
  }, [ready, loading, listKey, search, sort, characters, page, total, totalPages]);

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
      if (page !== 1) setPage(1);
    },
    [page, setPage]
  );

  const reload = useCallback(() => {
    if (limit == null) return;
    lastQueryRef.current = "";
    fetchCharacters(page, limit);
  }, [fetchCharacters, limit, page]);

  return {
    search,
    setSearch: handleSearchChange,
    characters,
    loading: loading || limit == null,
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
