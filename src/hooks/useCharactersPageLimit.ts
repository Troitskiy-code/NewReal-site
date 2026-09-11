"use client";

import { useLayoutEffect, useState } from "react";
import {
  CHARACTERS_DESKTOP_MEDIA,
  CHARACTERS_PAGE_LIMIT_MOBILE,
  getCharactersPageLimit,
} from "@/lib/charactersList";

export function useCharactersPageLimit(): number | null {
  const [limit, setLimit] = useState<number | null>(null);

  useLayoutEffect(() => {
    const media = window.matchMedia(CHARACTERS_DESKTOP_MEDIA);
    const apply = () => setLimit(getCharactersPageLimit(media.matches));
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  return limit;
}
