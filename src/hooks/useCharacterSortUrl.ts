"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DEFAULT_CHARACTER_SORT, isCharacterSort, type CharacterSort } from "@/lib/characterSort";

export function useCharacterSortUrl() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const sort = useMemo(() => {
    const param = searchParams.get("sort");
    return isCharacterSort(param) ? param : DEFAULT_CHARACTER_SORT;
  }, [searchParams]);

  useEffect(() => {
    if (!searchParams.get("sort")) {
      const params = new URLSearchParams(searchParams.toString());
      params.set("sort", DEFAULT_CHARACTER_SORT);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    }
  }, [pathname, router, searchParams]);

  const setSort = useCallback(
    (value: CharacterSort) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("sort", value);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  return { sort, setSort };
}
