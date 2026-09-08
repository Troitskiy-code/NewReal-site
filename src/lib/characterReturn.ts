"use client";

import { useLayoutEffect } from "react";

const STORAGE_KEY = "nv:character-return";

export type CharacterReturnSnapshot = {
  href: string;
  listKey?: string;
  search?: string;
  sort?: string;
  characters?: unknown[];
  page?: number;
  hasMore?: boolean;
  total?: number;
  windowY: number;
  mainY: number;
};

type ListState = {
  listKey: string;
  search: string;
  sort: string;
  characters: unknown[];
  page: number;
  hasMore: boolean;
  total: number;
};

let pendingList: ListState | null = null;
let restoreTimers: number[] = [];

function findScrollContainer(): HTMLElement | null {
  const node = document.querySelector("[data-character-list-scroll]");
  return node instanceof HTMLElement ? node : null;
}

function hrefPathname(href: string) {
  const queryIndex = href.indexOf("?");
  const hashIndex = href.indexOf("#");
  let end = href.length;
  if (queryIndex >= 0) end = Math.min(end, queryIndex);
  if (hashIndex >= 0) end = Math.min(end, hashIndex);
  return href.slice(0, end);
}

function sameOriginReferrer() {
  try {
    return Boolean(document.referrer) && new URL(document.referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function rememberCharacterListState(state: ListState) {
  pendingList = state;
}

export function readCharacterReturn(): CharacterReturnSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CharacterReturnSnapshot;
    if (!parsed || typeof parsed.href !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function captureCharacterReturn() {
  if (typeof window === "undefined") return;
  const main = findScrollContainer();
  const snapshot: CharacterReturnSnapshot = {
    href: `${window.location.pathname}${window.location.search}`,
    windowY: window.scrollY,
    mainY: main?.scrollTop ?? 0,
    ...(pendingList ?? {}),
  };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export function characterReturnMatches(snapshot: CharacterReturnSnapshot | null, listKey: string, sort: string) {
  if (!snapshot || snapshot.listKey !== listKey || snapshot.sort !== sort) return false;
  if (typeof window === "undefined") return false;
  return hrefPathname(snapshot.href) === window.location.pathname;
}

export function restoreCharacterScroll(snapshot: CharacterReturnSnapshot | null) {
  if (!snapshot || typeof window === "undefined") return;
  const apply = () => {
    if (hrefPathname(snapshot.href) !== window.location.pathname) return;
    window.scrollTo(0, snapshot.windowY || 0);
    const main = findScrollContainer();
    if (main) main.scrollTop = snapshot.mainY || 0;
  };
  restoreTimers.forEach((id) => window.clearTimeout(id));
  restoreTimers = [];
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
  restoreTimers.push(window.setTimeout(apply, 50), window.setTimeout(apply, 250));
}

export function closeCharacterPage(
  router: { back: () => void; push: (href: string) => void },
  galleryHref: string
) {
  const snapshot = readCharacterReturn();
  if (snapshot && sameOriginReferrer() && window.history.length > 1) {
    router.back();
    return;
  }
  if (snapshot?.href) {
    router.push(snapshot.href);
    return;
  }
  router.push(galleryHref);
}

export function clearCharacterReturn() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
  pendingList = null;
}

export function useRestoreCharacterScroll(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const snapshot = readCharacterReturn();
    if (!snapshot || hrefPathname(snapshot.href) !== window.location.pathname) return;
    restoreCharacterScroll(snapshot);
    clearCharacterReturn();
  }, [enabled]);
}
