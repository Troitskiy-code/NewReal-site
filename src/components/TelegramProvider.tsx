"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getLocaleFromPath, stripLocalePrefix } from "@/lib/i18nConfig";

// Telegram WebApp SDK integration. Mounted for every page, active only in the Telegram context
// decided by the server (context cookie or the /tg entry), never by window.Telegram alone.
// The regular site renders this as a plain context provider and loads nothing.

export const TELEGRAM_SDK_URL = "https://telegram.org/js/telegram-web-app.js?59";

type TelegramBackButton = { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
type TelegramInsets = { top: number; bottom: number; left: number; right: number };
export type TelegramWebApp = {
  initData: string;
  version: string;
  colorScheme: "light" | "dark";
  safeAreaInset?: TelegramInsets;
  contentSafeAreaInset?: TelegramInsets;
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  setBottomBarColor?(color: string): void;
  disableVerticalSwipes?(): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
  onEvent(event: string, cb: () => void): void;
  offEvent(event: string, cb: () => void): void;
  BackButton: TelegramBackButton;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
    __nvTgLaunch?: { initData: string };
  }
}

// Palette tokens of the dark NewVerse theme (globals.css): Telegram's own header, background
// and bottom bar are painted in them, so the app looks the same in light and dark Telegram themes.
const PALETTE = { header: "#0d0d0d", background: "#0a0a0a" };
// Top-level sections: Telegram's back button is hidden there.
const ROOT_PATHS = new Set(["/", "/chats", "/create", "/profile", "/favorites", "/tg", "/tg/unavailable"]);

const TelegramModeContext = createContext(false);
const TelegramAppContext = createContext<TelegramWebApp | null>(null);

export function useTelegramMode(): boolean {
  return useContext(TelegramModeContext);
}

export function useTelegramWebApp(): TelegramWebApp | null {
  return useContext(TelegramAppContext);
}

let sdkPromise: Promise<TelegramWebApp | null> | null = null;

export function loadTelegramSdk(): Promise<TelegramWebApp | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.Telegram?.WebApp) return Promise.resolve(window.Telegram.WebApp);
  sdkPromise ??= new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = TELEGRAM_SDK_URL;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.onload = () => resolve(window.Telegram?.WebApp ?? null);
    script.onerror = () => { sdkPromise = null; resolve(null); };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

function setupWebApp(app: TelegramWebApp): () => void {
  const root = document.documentElement;
  const at = (version: string) => {
    try { return app.isVersionAtLeast(version); } catch { return false; }
  };
  try {
    app.ready();
    app.expand();
    if (at("6.1")) {
      app.setHeaderColor(PALETTE.header);
      app.setBackgroundColor(PALETTE.background);
    }
    if (at("7.10")) app.setBottomBarColor?.(PALETTE.header);
    // Scrolling a long chat must not swipe the app closed.
    if (at("7.7")) app.disableVerticalSwipes?.();
  } catch { /* an older client without these methods still works */ }

  const theme = () => { root.dataset.tgColorScheme = app.colorScheme === "light" ? "light" : "dark"; };
  theme();
  app.onEvent("themeChanged", theme);

  const safeArea = () => {
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const safe = app.safeAreaInset?.[side] ?? 0;
      const content = app.contentSafeAreaInset?.[side] ?? 0;
      root.style.setProperty(`--nv-tg-safe-${side}`, `${Math.max(0, Number.isFinite(safe) ? safe : 0, Number.isFinite(content) ? content : 0)}px`);
    }
  };
  safeArea();
  app.onEvent("safeAreaChanged", safeArea);
  app.onEvent("contentSafeAreaChanged", safeArea);

  // Visible height above the on-screen keyboard: the chat shell follows it (iOS does not resize).
  const viewport = window.visualViewport;
  const resize = () => {
    root.style.setProperty("--nv-tg-vvh", `${Math.round(viewport?.height ?? window.innerHeight)}px`);
    if (window.scrollY > 0 && document.activeElement?.tagName === "TEXTAREA") window.scrollTo(0, 0);
  };
  resize();
  viewport?.addEventListener("resize", resize);
  app.onEvent("viewportChanged", resize);

  // External links leave the Mini App through Telegram, never as a navigation inside it.
  const click = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor || event.defaultPrevented) return;
    let url: URL;
    try { url = new URL(anchor.href, window.location.href); } catch { return; }
    if (url.origin === window.location.origin || !/^https?:$/.test(url.protocol)) return;
    event.preventDefault();
    if (url.hostname === "t.me") app.openTelegramLink(url.href);
    else app.openLink(url.href);
  };
  document.addEventListener("click", click, true);

  return () => {
    app.offEvent("themeChanged", theme);
    app.offEvent("safeAreaChanged", safeArea);
    app.offEvent("contentSafeAreaChanged", safeArea);
    app.offEvent("viewportChanged", resize);
    viewport?.removeEventListener("resize", resize);
    document.removeEventListener("click", click, true);
    for (const side of ["top", "bottom", "left", "right"]) root.style.removeProperty(`--nv-tg-safe-${side}`);
    root.style.removeProperty("--nv-tg-vvh");
  };
}

function TelegramBackButtonSync({ app }: { app: TelegramWebApp }) {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    const path = stripLocalePrefix(pathname);
    const back = () => {
      if (window.history.length > 1) router.back();
      else router.push(`/${getLocaleFromPath(pathname) ?? "ru"}`);
    };
    try {
      if (ROOT_PATHS.has(path)) app.BackButton.hide();
      else app.BackButton.show();
      app.BackButton.onClick(back);
    } catch { /* BackButton needs Bot API 6.1 */ }
    return () => { try { app.BackButton.offClick(back); } catch { /* see above */ } };
  }, [app, pathname, router]);
  return null;
}

export function TelegramProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [app, setApp] = useState<TelegramWebApp | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void loadTelegramSdk().then((webApp) => {
      if (cancelled || !webApp) return;
      cleanup = setupWebApp(webApp);
      setApp(webApp);
    });
    return () => { cancelled = true; cleanup?.(); };
  }, [enabled]);

  return (
    <TelegramModeContext.Provider value={enabled}>
      <TelegramAppContext.Provider value={enabled ? app : null}>
        {enabled && app ? <TelegramBackButtonSync app={app} /> : null}
        {children}
      </TelegramAppContext.Provider>
    </TelegramModeContext.Provider>
  );
}

/** Opens a page outside the Mini App (the user's browser); a new tab elsewhere. */
export function openOutsideTelegram(url: string): void {
  const absolute = new URL(url, window.location.origin).href;
  // A tap right after a page load may come before the SDK script: wait for it.
  void loadTelegramSdk().then((app) => {
    if (app) app.openLink(absolute);
    else window.open(absolute, "_blank", "noopener,noreferrer");
  });
}
