"use client";

import LocaleLink from "./LocaleLink";
import { LuMenu, LuX } from "react-icons/lu";
import Logo, { LogoMark } from "./Logo";
import UserAvatarMenu from "./UserAvatarMenu";
import NotificationBell from "./NotificationBell";
import LanguageSwitcher from "./LanguageSwitcher";
import { useSidebar } from "./SidebarContext";
import { useTranslation } from "react-i18next";

export default function Header() {
  const { toggle, isExpanded } = useSidebar();
  const { t } = useTranslation();

  return (
    <header className="nv-app-header fixed top-0 left-0 right-0 z-[60] m-0 h-14 border-b border-wd-border bg-wd-bg/90 px-0 backdrop-blur-md md:h-20">
      <div className="relative flex h-full w-full items-center">
        <button
          type="button"
          onClick={toggle}
          className="absolute left-0 top-0 z-[60] m-0 flex h-full w-14 items-center justify-center border-r border-wd-border text-wd-text-secondary transition-colors hover:text-white md:hidden"
          aria-label={isExpanded ? t("header.closeMenu") : t("header.openMenu")}
          aria-expanded={isExpanded}
        >
          {isExpanded ? <LuX size={24} /> : <LuMenu size={24} />}
        </button>

        <div className="flex w-full items-center justify-between gap-3 pr-3 md:pr-6">
          <LocaleLink href="/" className="ml-[4.25rem] flex min-w-0 items-center gap-2 md:ml-6 md:gap-3">
            <LogoMark className="h-6 w-6 shrink-0 text-wd-text md:h-8 md:w-8" />
            <span className="sr-only">NewVerse</span>
            {/* Icon only on narrow phones: next to the sign-in button the wordmark truncated to "NEW…". */}
            <span aria-hidden className="hidden min-w-0 min-[400px]:inline">
              <Logo size="sm" className="truncate text-lg md:text-2xl" />
            </span>
          </LocaleLink>

          <div className="flex shrink-0 items-center gap-2 md:gap-3">
            <div className="hidden md:block">
              <LanguageSwitcher />
            </div>
            <NotificationBell />
            <UserAvatarMenu />
          </div>
        </div>
      </div>
    </header>
  );
}
