"use client";

import LocaleLink, { useCurrentLocale, useLocalizedPathname } from "./LocaleLink";
import { useSession, signOut } from "next-auth/react";
import { useState, useEffect, useRef } from "react";
import { FaUser, FaSignInAlt, FaSignOutAlt } from "react-icons/fa";
import { useTranslation } from "react-i18next";
import VerseCoinsBalance from "./VerseCoinsBalance";
import { withLocale } from "@/lib/i18nConfig";
import LanguageSwitcher from "./LanguageSwitcher";
import { useTelegramMode } from "./TelegramProvider";

function getInitials(name, email) {
  const source = (name || email || "U").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function MobileLanguageRow() {
  const { t } = useTranslation();

  return (
    <div className="md:hidden border-t border-[#2A2A2A] px-4 py-2.5">
      <p className="mb-1.5 text-xs text-[#A0A0A0]">{t("language.label")}</p>
      <LanguageSwitcher variant="menu" />
    </div>
  );
}

export default function UserAvatarMenu() {
  const { data: session, status } = useSession();
  const pathname = useLocalizedPathname();
  const locale = useCurrentLocale();
  const { t } = useTranslation();
  const telegram = useTelegramMode();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  if (status === "loading") {
    return <div className="h-8 w-8 animate-pulse rounded-full bg-[#2A2A2A] md:h-10 md:w-10" />;
  }

  if (status === "unauthenticated") {
    return (
      <LocaleLink
        href="/login"
        className="inline-flex min-h-10 items-center gap-2 rounded-full border border-white/15 px-4 text-sm font-semibold text-white transition-colors hover:border-white/30 hover:bg-white/5"
      >
        <FaSignInAlt size={14} aria-hidden className="text-wd-text-secondary" />
        {t("auth.login")}
      </LocaleLink>
    );
  }

  const user = session?.user;
  const initials = getInitials(user?.name, user?.email);
  const isProfileActive = pathname === "/profile" || pathname.startsWith("/edit/");

  const dropdownItems = [
    { name: t("header.menu.profile"), path: "/profile", icon: FaUser, active: isProfileActive },
  ];

  return (
    <div ref={menuRef} className="relative flex items-center gap-2 md:gap-3">
      <VerseCoinsBalance />
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border-2 border-[#2A2A2A] bg-[#0A0A0A] transition-colors hover:border-wd-primary/50 md:h-10 md:w-10"
        aria-label={t("header.profileMenu")}
        aria-expanded={open}
      >
        {user?.image ? (
          <img src={user.image} alt={user.name || t("header.menu.profile")} className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs font-bold text-white">{initials}</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 min-w-[200px] overflow-hidden rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] py-1 shadow-xl">
          {user?.name && (
            <div className="border-b border-[#2A2A2A] px-4 py-3">
              <p className="truncate text-sm font-bold text-white">{user.name}</p>
              {user.email && <p className="truncate text-xs text-[#A0A0A0]">{user.email}</p>}
            </div>
          )}

          <ul className="py-1">
            {dropdownItems.map((item) => {
              const Icon = item.icon;
              const itemClass = `flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                item.active
                  ? "bg-wd-primary/12 text-wd-primary-soft"
                  : "text-white hover:bg-[#2A2A2A]"
              }`;

              return (
                <li key={item.name}>
                  <LocaleLink href={item.path} className={itemClass} onClick={() => setOpen(false)}>
                    <Icon size={16} className="shrink-0" />
                    {item.name}
                  </LocaleLink>
                </li>
              );
            })}
          </ul>

          <MobileLanguageRow />

          {/* Inside Telegram the account is the Telegram one; the next launch would sign in again. */}
          {!telegram && <div className="border-t border-[#2A2A2A] py-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                signOut({ callbackUrl: withLocale("/login", locale) });
              }}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-wd-primary-soft transition-colors hover:bg-[#2A2A2A]"
            >
              <FaSignOutAlt size={16} />
              {t("profile.logout")}
            </button>
          </div>}
        </div>
      )}
    </div>
  );
}
