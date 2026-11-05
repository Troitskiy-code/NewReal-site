"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import type { CatalogFacets } from "@/lib/catalogFilters";

/** Counts for the open filter panel or the empty state; null until the first answer arrives. */
export function useCatalogFacets(enabled: boolean, filtersQuery: string, search: string, hideAdult: boolean) {
  const query = new URLSearchParams(filtersQuery);
  if (search.trim()) query.set("search", search.trim());
  if (hideAdult) query.set("adult", "hide");
  const key = query.toString();
  const [loaded, setLoaded] = useState<{ key: string; facets: CatalogFacets } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      axios.get<CatalogFacets>(`/api/characters/facets?${key}`, { signal: controller.signal })
        .then(({ data }) => setLoaded({ key, facets: data }))
        .catch(() => {});
    }, 120);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [enabled, key]);

  // A stale answer still drives the numbers while the next one loads, so the panel does not flicker.
  return loaded?.facets ?? null;
}
