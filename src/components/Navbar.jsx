"use client";

import Link from "next/link";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
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
import toast from "react-hot-toast";
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
    name: "Главная",
    path: "/",
    iconActive: FaHome,
    iconInactive: FaHome,
    inactiveMuted: true,
  },
  {
    name: "Мои чаты",
    path: "/chats",
    iconInactive: FaRegComments,
    iconActive: FaComments,
    matchPaths: ["/chats", "/chat"],
  },
  {
    name: "Подписка",
    path: "/pricing",
    iconInactive: FaRegStar,
    iconActive: FaStar,
    matchPaths: ["/pricing", "/subscription"],
  },
  {
    name: "VerseCoins",
    path: "/coins",
    iconActive: FaCoins,
    iconInactive: FaCoins,
    inactiveMuted: true,
  },
  {
    name: "Создать персонажа",
    path: "/create",
    iconInactive: FaPlusCircle,
    iconActive: FaPlusCircle,
    inactiveMuted: true,
    matchPaths: ["/create", "/edit"],
  },
  {
    name: "Профиль",
    path: "/profile",
    iconInactive: FaUser,
    iconActive: FaUser,
    matchPaths: ["/profile", "/edit"],
  },
  {
    name: "Избранное",
    path: "/favorites",
    iconInactive: FaRegHeart,
    iconActive: FaHeart,
    matchPaths: ["/favorites"],
  },
  {
    name: "Поддержка",
    path: "/support",
    iconInactive: FaRegQuestionCircle,
    iconActive: FaQuestionCircle,
    stub: true,
    stubMessage: "Раздел поддержки скоро будет доступен",
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
  return (
    <ul className={`space-y-2 ${showLabels ? "px-2" : "px-1"}`}>
      {NAV_ITEMS.map((item) => {
        const isActive = isNavItemActive(item, pathname);

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
              {item.name}
            </span>
          </>
        );

        if (item.stub) {
          return (
            <li key={item.name}>
              <button type="button" onClick={() => onItemClick(item)} className={linkClass}>
                {content}
              </button>
            </li>
          );
        }

        return (
          <li key={item.name}>
            <Link href={item.path} onClick={() => onItemClick(item)} className={linkClass}>
              {content}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default function Navbar() {
  const pathname = usePathname();
  const { isExpanded, sidebarWidth, collapse, isMobile } = useSidebar();

  const desktopPanelWidth = isExpanded ? SIDEBAR_EXPANDED_DESKTOP : SIDEBAR_COLLAPSED_DESKTOP;
  const showDesktopLabels = isExpanded;

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

  const handleNavClick = (item) => {
    if (item.stub) {
      toast(item.stubMessage || "Раздел скоро будет доступен", { icon: "🔜" });
      if (isMobile) collapse();
      return;
    }
    if (isMobile) collapse();
  };

  return (
    <>
      {/* Mobile overlay menu — slide via CSS `left`, same 300ms as desktop width */}
      <div
        className={`nv-mobile-nav-overlay ${isExpanded ? "is-open" : ""}`}
        onClick={collapse}
        aria-hidden={!isExpanded}
      />

      <aside
        className={`nv-mobile-drawer border-r border-[#2A2A2A] bg-[#1A1A1A] text-white shadow-2xl ${
          isExpanded ? "is-open" : "pointer-events-none"
        }`}
        aria-hidden={!isExpanded}
      >
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-4">
          <NavMenuList
            pathname={pathname}
            showLabels
            iconSize={24}
            onItemClick={handleNavClick}
          />
        </nav>
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
