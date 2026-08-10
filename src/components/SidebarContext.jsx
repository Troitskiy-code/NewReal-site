"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export const SIDEBAR_COLLAPSED_DESKTOP = 80;
export const SIDEBAR_EXPANDED_DESKTOP = 280;
export const SIDEBAR_MOBILE_DRAWER_WIDTH = 240;

const SidebarContext = createContext(null);

function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return isMobile;
}

export function SidebarProvider({ children }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isMobile = useIsMobileViewport();

  useEffect(() => {
    setIsExpanded(false);
  }, [isMobile]);

  const value = useMemo(() => {
    const desktopWidth = isExpanded ? SIDEBAR_EXPANDED_DESKTOP : SIDEBAR_COLLAPSED_DESKTOP;

    return {
      isExpanded,
      isMobile,
      /** Width reserved in page layout (desktop sidebar only). */
      sidebarWidth: isMobile ? 0 : desktopWidth,
      /** Drawer width when mobile menu is open. */
      mobileDrawerWidth: SIDEBAR_MOBILE_DRAWER_WIDTH,
      toggle: () => setIsExpanded((prev) => !prev),
      collapse: () => setIsExpanded(false),
    };
  }, [isExpanded, isMobile]);

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within SidebarProvider");
  }
  return ctx;
}
