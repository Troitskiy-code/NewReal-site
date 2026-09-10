"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import Footer from "@/components/Footer";
import LocaleLink, { useCurrentLocale } from "@/components/LocaleLink";
import { dateLocale } from "@/lib/i18nConfig";
import { showError, showSuccess } from "@/lib/toast";

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  createdAt: string;
};

const FILTERS = [
  { id: "all", labelKey: "notifications.filterAll" },
  { id: "purchase_vc", labelKey: "notifications.typePurchaseVc" },
  { id: "purchase_subscription", labelKey: "notifications.typePurchaseSubscription" },
  { id: "daily_bonus", labelKey: "notifications.typeDailyBonus" },
  { id: "admin", labelKey: "notifications.typeAdmin" },
] as const;

function typeIcon(type: string) {
  if (type === "purchase_vc") return FaCoins;
  if (type === "purchase_subscription") return FaCrown;
  if (type === "daily_bonus") return FaGift;
  return FaInfoCircle;
}

function formatRelativeTime(
  value: string,
  t: (key: string, options?: Record<string, number>) => string,
  locale: string
) {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return t("notifications.justNow");
  if (minutes < 60) return t("notifications.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("notifications.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("notifications.daysAgo", { count: days });
  return date.toLocaleDateString(dateLocale(locale), {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function NotificationsPage() {
  const { status } = useSession();
  const { t } = useTranslation();
  const locale = useCurrentLocale();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [marking, setMarking] = useState(false);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get("/api/notifications");
      setNotifications(Array.isArray(data.notifications) ? data.notifications : []);
      setUnreadCount(Number(data.unreadCount) || 0);
    } catch {
      showError(t("notifications.loadError"));
      setNotifications([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (status === "authenticated") {
      fetchNotifications();
    } else if (status === "unauthenticated") {
      setLoading(false);
    }
  }, [status, fetchNotifications]);

  const visible = useMemo(
    () => (filter === "all" ? notifications : notifications.filter((item) => item.type === filter)),
    [filter, notifications]
  );

  const markAllRead = async () => {
    if (unreadCount === 0 || marking) return;
    setMarking(true);
    try {
      await axios.post("/api/notifications/read-all");
      setNotifications((prev) => prev.map((item) => ({ ...item, read: true })));
      setUnreadCount(0);
      showSuccess(t("notifications.markedRead"));
    } catch {
      showError(t("notifications.loadError"));
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-wd-bg text-wd-text">
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 overflow-y-auto px-4 py-8 scrollbar-subtle sm:px-6 lg:px-8">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-wd-secondary">
            <FaBell className="text-lg" />
            <span className="text-xs font-bold uppercase tracking-widest">{t("notifications.title")}</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-white">{t("notifications.title")}</h1>
        </div>

        {status === "unauthenticated" && (
          <div className="wd-card space-y-4 p-8 text-center">
            <FaBell className="mx-auto text-3xl text-wd-secondary opacity-60" />
            <p className="text-sm text-wd-text-secondary">{t("notifications.loginPrompt")}</p>
            <LocaleLink href="/login" className="wd-button inline-flex px-6 py-2.5 text-sm">
              {t("auth.login")}
            </LocaleLink>
          </div>
        )}

        {status === "authenticated" && loading && (
          <div className="wd-card flex items-center justify-center p-12">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
          </div>
        )}

        {status === "authenticated" && !loading && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {FILTERS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setFilter(item.id)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      filter === item.id
                        ? "border-[#6C63FF]/60 bg-[#6C63FF]/15 text-white"
                        : "border-[#2A2A2A] text-[#A0A0A0] hover:border-[#6C63FF]/40 hover:text-white"
                    }`}
                  >
                    {t(item.labelKey)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={markAllRead}
                disabled={unreadCount === 0 || marking}
                className="text-sm text-[#6C63FF] transition-colors hover:text-white disabled:cursor-default disabled:text-[#A0A0A0]"
              >
                {t("notifications.markAllRead")}
              </button>
            </div>

            {visible.length === 0 ? (
              <div className="wd-card space-y-3 p-10 text-center">
                <FaBell className="mx-auto text-3xl text-wd-secondary opacity-60" />
                <p className="text-sm text-wd-text-secondary">{t("notifications.empty")}</p>
              </div>
            ) : (
              <ul className="space-y-3">
                {visible.map((notification) => {
                  const Icon = typeIcon(notification.type);
                  return (
                    <li
                      key={notification.id}
                      className={`wd-card p-4 ${
                        notification.read ? "" : "border-[#6C63FF]/30 bg-[#6C63FF]/5"
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#2A2A2A] bg-[#0A0A0A]">
                          <Icon size={14} className={notification.read ? "text-[#A0A0A0]" : "text-[#6C63FF]"} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-3">
                            <p className="text-sm font-bold text-white">{notification.title}</p>
                            <p className="shrink-0 text-xs text-[#A0A0A0]">
                              {formatRelativeTime(notification.createdAt, t, locale)}
                            </p>
                          </div>
                          <p className="mt-1 text-sm text-[#A0A0A0]">{notification.message}</p>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
