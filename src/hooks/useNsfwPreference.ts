"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { NSFW_STORAGE_KEY } from "@/lib/nsfw";

function readRestrictNsfwCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((part) => part.trim() === "restrict_nsfw=true");
}

export function useNsfwPreference() {
  const { status } = useSession();
  const [showNSFW, setShowNSFWState] = useState(false);
  const [restrictNSFW, setRestrictNSFW] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setRestrictNSFW(readRestrictNsfwCookie());
    const stored = localStorage.getItem(NSFW_STORAGE_KEY);
    setShowNSFWState(stored === "true");
    setReady(true);
  }, []);

  const isAuthenticated = status === "authenticated";
  const canShowNSFWToggle = isAuthenticated && !restrictNSFW;
  const effectiveShowNSFW = canShowNSFWToggle && showNSFW;

  const setShowNSFW = useCallback(
    (value: boolean) => {
      if (!canShowNSFWToggle) return;
      setShowNSFWState(value);
      localStorage.setItem(NSFW_STORAGE_KEY, value ? "true" : "false");
    },
    [canShowNSFWToggle]
  );

  return {
    showNSFW: effectiveShowNSFW,
    setShowNSFW,
    canShowNSFWToggle,
    restrictNSFW,
    ready,
    isAuthenticated,
  };
}
