"use client";

import LocaleLink, { useLocalizedPathname } from "./LocaleLink";
import { useTranslation } from "react-i18next";
import { useEffect, useLayoutEffect, useState } from "react";
import {
  FaHome,
  FaComments,
  FaStar,
  FaCoins,
  FaPlusCircle,
  FaHeart,
  FaQuestionCircle,
  FaUser,
  FaRegComments,
  FaRegStar,
  FaRegHeart,
  FaRegQuestionCircle,
} from "react-icons/fa";
import {
  HEADER_HEIGHT_DESKTOP_PX,
  HEADER_HEIGHT_MOBILE_PX,
  SIDEBAR_COLLAPSED_DESKTOP,
  SIDEBAR_EXPANDED_DESKTOP,
} from "@/lib/layoutConstants";
import { useSidebar } from "./SidebarContext";

const ACTIVE_BLUE = "#4A90D9";

const NAV_ITEMS = [
  {
    nameKey: "header.menu.home",
    path: "/",
    iconActive: FaHome,
    iconInactive: FaHome,
    inactiveMuted: true,
  },
  {
    nameKey: "header.menu.chats",
    path: "/chats",
    iconInactive: FaRegComments,
    iconActive: FaComments,
    matchPaths: ["/chats", "/chat"],
  },
  {
    nameKey: "header.menu.pricing",
    path: "/pricing",
    iconInactive: FaRegStar,
    iconActive: FaStar,
    matchPaths: ["/pricing", "/subscription"],
  },
  {
    nameKey: "header.menu.coins",
    path: "/coins",
    iconActive: FaCoins,
    iconInactive: FaCoins,
    inactiveMuted: true,
  },
  {
    nameKey: "header.menu.create",
    path: "/create",
    iconInactive: FaPlusCircle,
    iconActive: FaPlusCircle,
    inactiveMuted: true,
    matchPaths: ["/create", "/edit"],
  },
  {
    nameKey: "header.menu.profile",
    path: "/profile",
    iconInactive: FaUser,
    iconActive: FaUser,
    matchPaths: ["/profile", "/edit"],
  },
  {
    nameKey: "header.menu.favorites",
    path: "/favorites",
    iconInactive: FaRegHeart,
    iconActive: FaHeart,
    matchPaths: ["/favorites"],
  },
  {
    nameKey: "header.menu.support",
    path: "/support",
    iconInactive: FaRegQuestionCircle,
    iconActive: FaQuestionCircle,
    matchPaths: ["/support"],
  },
];

function MenuIcon({ iconActive, iconInactive, active, inactiveMuted, size = 28 }) {
  const Icon = active ? iconActive : iconInactive;

  return (
    <Icon
      size={size}
      className={`shrink-0 ${!active && inactiveMuted ? "opacity-50" : ""}`}
      style={{ color: active ? ACTIVE_BLUE : "#FFFFFF" }}
    />
  );
}

function isNavItemActive(item, pathname) {
  const paths = item.matchPaths ?? [item.path];

  return paths.some((path) => {
    if (path === "/") return pathname === "/";
    return pathname === path || pathname.startsWith(`${path}/`);
  });
}

function NavMenuList({ pathname, showLabels, iconSize, onItemClick }) {
  const { t } = useTranslation();

  return (
    <ul className={`space-y-2 ${showLabels ? "px-2" : "px-1"}`}>
      {NAV_ITEMS.map((item) => {
        const isActive = isNavItemActive(item, pathname);
        const name = t(item.nameKey);

        const linkClass = `flex w-full items-center rounded-xl border transition-all duration-300 ${
          showLabels ? "gap-3 px-3 py-2.5" : "justify-center px-0 py-3 md:py-4"
        } ${
          isActive
            ? "border-[#4A90D9]/40 bg-[#4A90D9]/15"
            : "border-transparent text-white hover:bg-[#2A2A2A]"
        }`;

        const textClass = isActive ? "text-[#4A90D9]" : "text-white";

        const content = (
          <>
            <MenuIcon
              iconActive={item.iconActive}
              iconInactive={item.iconInactive}
              active={isActive}
              inactiveMuted={item.inactiveMuted}
              size={iconSize}
            />
            <span
              className={`overflow-hidden whitespace-nowrap text-sm font-semibold leading-none transition-all duration-300 ${textClass} ${
                showLabels ? "max-w-[200px] opacity-100" : "max-w-0 opacity-0"
              }`}
            >
              {name}
            </span>
          </>
        );

        return (
          <li key={item.nameKey}>
            <LocaleLink href={item.path} onClick={() => onItemClick(item)} className={linkClass}>
              {content}
            </LocaleLink>
          </li>
        );
      })}
    </ul>
  );
}

export default function Navbar() {
  const pathname = useLocalizedPathname();
  const { isExpanded, sidebarWidth, collapse, isMobile } = useSidebar();

  const desktopPanelWidth = isExpanded ? SIDEBAR_EXPANDED_DESKTOP : SIDEBAR_COLLAPSED_DESKTOP;
  const showDesktopLabels = isExpanded;
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
    const headerHeight = isMobile ? HEADER_HEIGHT_MOBILE_PX : HEADER_HEIGHT_DESKTOP_PX;
    document.body.style.paddingLeft = isMobile ? "0px" : `${sidebarWidth}px`;
    document.body.style.paddingTop = `${headerHeight}px`;
    document.body.style.transition = "padding-left 300ms ease-in-out";
    return () => {
      document.body.style.paddingLeft = "";
      document.body.style.paddingTop = "";
      document.body.style.transition = "";
    };
  }, [sidebarWidth, isMobile]);

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
        className={`nv-mobile-drawer border-[#2A2A2A] bg-[#1A1A1A] text-white ${
          mobileSlideOpen ? "is-open" : "pointer-events-none"
        }`}
        aria-hidden={!isExpanded}
      >
        <div className="nv-mobile-drawer-inner">
          <nav className="flex-1 overflow-y-auto overflow-x-hidden py-4">
            <NavMenuList
              pathname={pathname}
              showLabels
              iconSize={24}
              onItemClick={handleNavClick}
            />
          </nav>
        </div>
      </aside>

      {/* Desktop persistent sidebar */}
      <aside
        className="fixed left-0 top-20 z-[210] m-0 hidden h-[calc(100vh-5rem)] flex-col items-start justify-start overflow-hidden border-r border-[#2A2A2A] bg-[#1A1A1A] p-0 text-white shadow-2xl transition-all duration-300 ease-in-out md:flex"
        style={{ width: desktopPanelWidth }}
      >
        <nav className="m-0 w-full flex-1 overflow-y-auto overflow-x-hidden p-0 py-4">
          <NavMenuList
            pathname={pathname}
            showLabels={showDesktopLabels}
            iconSize={28}
            onItemClick={handleNavClick}
          />
        </nav>
      </aside>
    </>
  );
}
