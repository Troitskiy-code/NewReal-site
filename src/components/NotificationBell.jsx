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

  const markAllRead = async () => {
    if (unreadCount === 0) return;
    try {
      await axios.post("/api/notifications/read-all");
      setNotifications((prev) => prev.map((item) => ({ ...item, read: true })));
      setUnreadCount(0);
    } catch {
      // Keep current unread state.
    }
  };

  const markOneRead = async (notification) => {
    if (notification.read) return;
    try {
      await axios.post("/api/notifications/read", {
        notificationIds: [notification.id],
      });
      setNotifications((prev) =>
        prev.map((item) => (item.id === notification.id ? { ...item, read: true } : item))
      );
      setUnreadCount((count) => Math.max(0, count - 1));
    } catch {
      // Navigation still proceeds if the item has a link.
    }
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
        onClick={() => {
          setOpen((prev) => !prev);
          if (!open) fetchNotifications();
        }}
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
                const content = (
                  <span className="flex items-start gap-3">
                    <Icon
                      size={14}
                      className={`mt-0.5 shrink-0 ${notification.read ? "text-[#A0A0A0]" : "text-[#6C63FF]"}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-white">
                        {notification.title}
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-[#A0A0A0]">
                        {notification.message}
                      </span>
                      <span className="mt-1 block text-[11px] text-[#A0A0A0]">
                        {formatRelativeTime(notification.createdAt, t, locale)}
                      </span>
                    </span>
                    {!notification.read && (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#FF2D55]" />
                    )}
                  </span>
                );
                const itemClass = `block w-full px-4 py-2.5 text-left transition-colors hover:bg-[#2A2A2A] ${
                  notification.read ? "opacity-80" : "bg-[#6C63FF]/5"
                }`;

                return (
                  <li key={notification.id}>
                    {notification.link ? (
                      <LocaleLink
                        href={notification.link}
                        className={itemClass}
                        onClick={() => {
                          markOneRead(notification);
                          setOpen(false);
                        }}
                      >
                        {content}
                      </LocaleLink>
                    ) : (
                      <button
                        type="button"
                        className={itemClass}
                        onClick={() => {
                          markOneRead(notification);
                          setOpen(false);
                        }}
                      >
                        {content}
                      </button>
                    )}
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
