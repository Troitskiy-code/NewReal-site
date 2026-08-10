"use client";

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { CHARACTERS_PAGE_LIMIT } from "@/lib/charactersList";

export function usePaginatedCharacters({ search, sort, showNSFW = false }) {
  const [characters, setCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);

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
        if (showNSFW) params.set("showNSFW", "true");

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
    [search, sort, showNSFW]
  );

  useEffect(() => {
    setPage(1);
    fetchCharacters(1, false);
  }, [fetchCharacters]);

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
