"use client";

import LocaleLink from "./LocaleLink";
import Image from "next/image";
import { LuMenu, LuX } from "react-icons/lu";
import Logo from "./Logo";
import UserAvatarMenu from "./UserAvatarMenu";
import NotificationBell from "./NotificationBell";
import LanguageSwitcher from "./LanguageSwitcher";
import { useSidebar } from "./SidebarContext";
import { useTranslation } from "react-i18next";

export default function Header() {
  const { toggle, isExpanded } = useSidebar();
  const { t } = useTranslation();

  return (
    <header className="fixed top-0 left-0 right-0 z-[60] m-0 h-14 border-b border-wd-border bg-[#0d0d0d]/90 px-0 backdrop-blur-md md:h-20">
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
            <Image
              src="/logo.png"
              alt="NewVerse"
              width={45}
              height={45}
              className="h-7 w-7 shrink-0 md:h-10 md:w-10"
              priority
            />
            <Logo size="sm" className="truncate text-lg md:text-2xl" />
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
