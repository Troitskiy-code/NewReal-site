"use client";

import LocaleLink, { useLocalizedPathname } from "./LocaleLink";
import { useTranslation } from "react-i18next";
import { Fragment, useEffect, useLayoutEffect, useState } from "react";
import { useSidebar } from "./SidebarContext";
import LanguageSwitcher from "./LanguageSwitcher";
import { NAV_SECTIONS, isNavItemActive } from "./navItems";

function NavMenuList({ pathname, variant, onItemClick }) {
  const { t } = useTranslation();
  const isRail = variant === "rail";

  return (
    <ul className={`flex flex-col gap-1 ${isRail ? "items-center px-2 lg:items-stretch lg:px-3" : "px-3"}`}>
      {NAV_SECTIONS.map((section, index) => (
        <Fragment key={index}>
          {index > 0 && <li aria-hidden className="mx-3 my-2 h-px self-stretch bg-wd-border" />}
          {section.map((item) => {
            const isActive = isNavItemActive(item, pathname);
            const name = t(item.nameKey);
            const Icon = item.icon;

            return (
              <li key={item.nameKey} className={isRail ? "w-full" : undefined}>
                <LocaleLink
                  href={item.path}
                  prefetch={item.prefetch === true ? true : undefined}
                  onClick={onItemClick}
                  title={isRail ? name : undefined}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex min-h-11 items-center gap-3 rounded-xl text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary ${
                    isRail ? "justify-center px-0 lg:justify-start lg:px-3" : "px-3"
                  } ${
                    isActive
                      ? "bg-wd-primary/12 font-semibold text-wd-primary-soft"
                      : "font-medium text-wd-text-secondary hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <Icon size={20} aria-hidden className="shrink-0" />
                  <span className={isRail ? "sr-only lg:not-sr-only lg:truncate" : "truncate"}>{name}</span>
                </LocaleLink>
              </li>
            );
          })}
        </Fragment>
      ))}
    </ul>
  );
}

export default function Navbar() {
  const pathname = useLocalizedPathname();
  const { t } = useTranslation();
  const { isExpanded, collapse, isMobile } = useSidebar();
  const [mobileSlideOpen, setMobileSlideOpen] = useState(false);

  // Paint the closed width first, then open — otherwise iOS skips the 300ms width tween.
  useLayoutEffect(() => {
    if (!isExpanded) {
      setMobileSlideOpen(false);
      return undefined;
    }
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => setMobileSlideOpen(true));
    });
    return () => cancelAnimationFrame(id);
  }, [isExpanded]);

  useEffect(() => {
    const updateOverflow = () => {
      const mobile = window.matchMedia("(max-width: 767px)").matches;
      document.body.style.overflow = mobile && isExpanded ? "hidden" : "";
    };

    updateOverflow();
    window.addEventListener("resize", updateOverflow);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("resize", updateOverflow);
    };
  }, [isExpanded]);

  const handleNavClick = () => {
    if (isMobile) collapse();
  };

  return (
    <>
      {/* Mobile overlay: below header so the burger stays undimmed (z-40 vs header z-60). */}
      <div
        className={`nv-mobile-nav-overlay ${mobileSlideOpen ? "is-open" : ""}`}
        onClick={collapse}
        aria-hidden={!isExpanded}
      />

      <aside
        className={`nv-mobile-drawer border-wd-border bg-[#101010] text-white ${
          mobileSlideOpen ? "is-open" : "pointer-events-none"
        }`}
        aria-hidden={!isExpanded}
      >
        <div className="nv-mobile-drawer-inner">
          <nav aria-label={t("header.mainNav")} className="flex-1 overflow-y-auto overflow-x-hidden py-4">
            <NavMenuList pathname={pathname} variant="drawer" onItemClick={handleNavClick} />
          </nav>
          <div className="border-t border-wd-border px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <p className="mb-2 text-xs text-wd-text-secondary">{t("language.label")}</p>
            <LanguageSwitcher variant="menu" />
          </div>
        </div>
      </aside>

      {/* Desktop persistent sidebar: icon rail on md, labelled sidebar from lg (widths mirror body padding). */}
      <aside className="fixed left-0 top-20 z-[210] hidden h-[calc(100vh-5rem)] w-20 flex-col overflow-hidden border-r border-wd-border bg-[#0d0d0d] text-white md:flex lg:w-[232px]">
        <nav aria-label={t("header.mainNav")} className="w-full flex-1 overflow-y-auto overflow-x-hidden py-4 scrollbar-subtle">
          <NavMenuList pathname={pathname} variant="rail" onItemClick={handleNavClick} />
        </nav>
      </aside>
    </>
  );
}
