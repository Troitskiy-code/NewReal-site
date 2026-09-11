"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DEFAULT_CHARACTER_SORT, isCharacterSort, type CharacterSort } from "@/lib/characterSort";

function parsePage(value: string | null): number {
  const parsed = Number.parseInt(value || "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function useCharacterSortUrl() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const sort = useMemo(() => {
    const param = searchParams.get("sort");
    return isCharacterSort(param) ? param : DEFAULT_CHARACTER_SORT;
  }, [searchParams]);

  const page = useMemo(() => parsePage(searchParams.get("page")), [searchParams]);

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  useEffect(() => {
    if (!searchParams.get("sort")) {
      replaceParams((params) => {
        params.set("sort", DEFAULT_CHARACTER_SORT);
      });
    }
  }, [replaceParams, searchParams]);

  const setSort = useCallback(
    (value: CharacterSort) => {
      replaceParams((params) => {
        params.set("sort", value);
        params.delete("page");
      });
    },
    [replaceParams]
  );

  const setPage = useCallback(
    (value: number) => {
      const next = Math.max(1, Math.trunc(value) || 1);
      replaceParams((params) => {
        if (next <= 1) {
          params.delete("page");
        } else {
          params.set("page", String(next));
        }
      });
    },
    [replaceParams]
  );

  return { sort, setSort, page, setPage };
}
