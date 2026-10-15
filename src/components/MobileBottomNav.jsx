"use client";

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import LocaleLink, { useLocalizedPathname } from "./LocaleLink";
import { useSidebar } from "./SidebarContext";
import { BOTTOM_NAV_ITEMS, TELEGRAM_BOTTOM_NAV_ITEMS, isNavItemActive } from "./navItems";
import { useTelegramMode } from "./TelegramProvider";
import { MOBILE_BOTTOM_NAV_HEIGHT_PX } from "@/lib/layoutConstants";

// Full-height screens with their own bottom composer or sticky actions.
const HIDDEN_PREFIXES = ["/chat/", "/create/", "/edit/", "/admin"];

export default function MobileBottomNav() {
  const pathname = useLocalizedPathname();
  const visible = !HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  const { t } = useTranslation();
  const { collapse } = useSidebar();
  const items = useTelegramMode() ? TELEGRAM_BOTTOM_NAV_ITEMS : BOTTOM_NAV_ITEMS;

  useEffect(() => {
    if (!visible) return undefined;
    const media = window.matchMedia("(max-width: 767px)");
    const root = document.documentElement;
    const apply = () => {
      if (media.matches) root.style.setProperty("--nv-bottom-nav-height", `${MOBILE_BOTTOM_NAV_HEIGHT_PX}px`);
      else root.style.removeProperty("--nv-bottom-nav-height");
    };
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      root.style.removeProperty("--nv-bottom-nav-height");
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <>
      <div aria-hidden className="nv-bottom-nav-spacer h-[calc(64px+env(safe-area-inset-bottom))] md:hidden" />
      <nav
        aria-label={t("header.bottomNav")}
        className="nv-bottom-nav fixed inset-x-0 bottom-0 z-[45] border-t border-wd-border bg-[#0d0d0d]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
      >
        <ul className="grid h-16 grid-cols-5">
          {items.map((item) => {
            const isActive = isNavItemActive(item, pathname);
            const isCreate = item.path === "/create";
            const Icon = item.icon;

            return (
              <li key={item.path}>
                <LocaleLink
                  href={item.path}
                  prefetch={item.prefetch === true ? true : undefined}
                  onClick={collapse}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex h-full flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-wd-secondary ${
                    isActive ? "text-wd-primary-soft" : "text-wd-text-secondary"
                  }`}
                >
                  {isCreate ? (
                    <span className="flex h-7 w-10 items-center justify-center rounded-xl bg-wd-primary text-white">
                      <Icon size={18} aria-hidden />
                    </span>
                  ) : (
                    <Icon size={22} aria-hidden />
                  )}
                  <span className="leading-none">{t(item.shortKey)}</span>
                </LocaleLink>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
