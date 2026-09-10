"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";
import axios from "axios";
import {
  FaBell,
  FaCoins,
  FaCrown,
  FaGift,
  FaInfoCircle,
} from "react-icons/fa";
import LocaleLink, { useCurrentLocale } from "./LocaleLink";
import { dateLocale } from "@/lib/i18nConfig";

const POLL_MS = 30_000;

function typeIcon(type) {
  if (type === "purchase_vc") return FaCoins;
  if (type === "purchase_subscription") return FaCrown;
  if (type === "daily_bonus") return FaGift;
  return FaInfoCircle;
}

function formatRelativeTime(value, t, locale) {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return t("notifications.justNow");
  if (minutes < 60) return t("notifications.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("notifications.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("notifications.daysAgo", { count: days });
  return date.toLocaleDateString(dateLocale(locale), { day: "numeric", month: "short" });
}

export default function NotificationBell() {
  const { status } = useSession();
  const { t } = useTranslation();
  const locale = useCurrentLocale();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const menuRef = useRef(null);

  const fetchNotifications = useCallback(async () => {
    if (status !== "authenticated") return;
    try {
      const { data } = await axios.get("/api/notifications");
      setNotifications(Array.isArray(data.notifications) ? data.notifications : []);
      setUnreadCount(Number(data.unreadCount) || 0);
    } catch {
      // Keep the last known list if a poll fails.
    }
  }, [status]);

  const markAllRead = useCallback(async () => {
    try {
      await axios.post("/api/notifications/read-all");
      setNotifications((prev) => prev.map((item) => ({ ...item, read: true })));
      setUnreadCount(0);
    } catch {
      // Keep current unread state.
    }
  }, []);

  useEffect(() => {
    if (status !== "authenticated") {
      setNotifications([]);
      setUnreadCount(0);
      return undefined;
    }

    fetchNotifications();
    const id = setInterval(fetchNotifications, POLL_MS);
    return () => clearInterval(id);
  }, [status, fetchNotifications]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const openDropdown = async () => {
    const willOpen = !open;
    setOpen(willOpen);
    if (!willOpen) return;
    await fetchNotifications();
    await markAllRead();
  };

  if (status !== "authenticated") {
    return null;
  }

  const preview = notifications.slice(0, 10);
  const badgeLabel = unreadCount > 99 ? "99+" : String(unreadCount);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={openDropdown}
        className="relative flex h-8 w-8 items-center justify-center rounded-full border border-[#2A2A2A] bg-[#0A0A0A] text-white transition-colors hover:border-[#6C63FF]/50 hover:text-white md:h-10 md:w-10"
        aria-label={t("notifications.open")}
        aria-expanded={open}
      >
        <FaBell size={16} className="text-[#A0A0A0]" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#FF2D55] px-1 text-[10px] font-bold leading-none text-white">
            {badgeLabel}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-[#2A2A2A] bg-[#1A1A1A] shadow-xl">
          <div className="flex items-center justify-between gap-2 border-b border-[#2A2A2A] px-4 py-2.5">
            <p className="text-sm font-bold text-white">{t("notifications.title")}</p>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="text-xs text-[#6C63FF] transition-colors hover:text-white disabled:cursor-default disabled:text-[#A0A0A0]"
            >
              {t("notifications.markAllRead")}
            </button>
          </div>

          {preview.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-[#A0A0A0]">{t("notifications.empty")}</p>
          ) : (
            <ul className="max-h-[22rem] overflow-y-auto py-1">
              {preview.map((notification) => {
                const Icon = typeIcon(notification.type);
                return (
                  <li
                    key={notification.id}
                    className={`px-4 py-2.5 ${
                      notification.read ? "opacity-80" : "bg-[#6C63FF]/5"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <Icon
                        size={14}
                        className={`mt-0.5 shrink-0 ${notification.read ? "text-[#A0A0A0]" : "text-[#6C63FF]"}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-white">{notification.title}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-[#A0A0A0]">{notification.message}</p>
                        <p className="mt-1 text-[11px] text-[#A0A0A0]">
                          {formatRelativeTime(notification.createdAt, t, locale)}
                        </p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="border-t border-[#2A2A2A] py-1">
            <LocaleLink
              href="/notifications"
              className="block px-4 py-2.5 text-center text-sm text-[#6C63FF] transition-colors hover:bg-[#2A2A2A] hover:text-white"
              onClick={() => setOpen(false)}
            >
              {t("notifications.showAll")}
            </LocaleLink>
          </div>
        </div>
      )}
    </div>
  );
}
