"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

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

/** Desktop sidebar width is pure CSS (globals.css); this only drives the mobile drawer. */
export function SidebarProvider({ children }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isMobile = useIsMobileViewport();

  useEffect(() => {
    setIsExpanded(false);
  }, [isMobile]);

  const value = useMemo(
    () => ({
      isExpanded,
      isMobile,
      toggle: () => setIsExpanded((prev) => !prev),
      collapse: () => setIsExpanded(false),
    }),
    [isExpanded, isMobile]
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within SidebarProvider");
  }
  return ctx;
}
