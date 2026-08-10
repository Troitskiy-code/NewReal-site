"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import Footer from "@/components/Footer";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";
import { FaCoins, FaGift } from "react-icons/fa";

type BalanceData = {
  realCoins: number;
  lastDailyBonus: string | null;
};

type TokenPackage = {
  id: number;
  total: number;
  base?: number;
  bonus?: number;
  price: number;
  badge?: string;
};

const PACKAGES: TokenPackage[] = [
  { id: 1, total: 1000, price: 300 },
  { id: 2, total: 2400, base: 2000, bonus: 400, price: 600, badge: "+20%" },
  { id: 3, total: 7000, base: 5000, bonus: 2000, price: 1500, badge: "+40%" },
  { id: 4, total: 16000, base: 10000, bonus: 6000, price: 3000, badge: "+60%" },
  { id: 5, total: 36000, base: 20000, bonus: 16000, price: 5000, badge: "+80%" },
  { id: 6, total: 100000, base: 50000, bonus: 50000, price: 15000, badge: "+100%" },
];

const BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function formatCoins(value: number): string {
  return value.toLocaleString("ru-RU");
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0 мин.";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours} ч. ${minutes} мин.`;
  return `${minutes} мин.`;
}

function getMsUntilNextBonus(lastDailyBonus: string | null): number {
  if (!lastDailyBonus) return 0;
  const nextAt = new Date(lastDailyBonus).getTime() + BONUS_COOLDOWN_MS;
  return Math.max(0, nextAt - Date.now());
}

function canClaimBonus(lastDailyBonus: string | null): boolean {
  if (!lastDailyBonus) return true;
  return Date.now() - new Date(lastDailyBonus).getTime() >= BONUS_COOLDOWN_MS;
}

function handleBuy() {
  alert("Оплата через Unitpay будет доступна позже");
}

export default function RealCoinsPage() {
  const { status } = useSession();
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = useCallback(async () => {
    setLoadingBalance(true);
    setError(null);
    try {
      const { data } = await axios.get<BalanceData>("/api/user/balance");
      setBalance(data);
    } catch (err) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Не удалось загрузить баланс";
      setError(message);
      setBalance(null);
    } finally {
      setLoadingBalance(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      fetchBalance();
    }
  }, [status, fetchBalance]);

  const handleClaimBonus = async () => {
    setClaiming(true);
    try {
      const { data } = await axios.post<BalanceData & { message: string }>("/api/daily-bonus");
      setBalance({
        realCoins: data.realCoins,
        lastDailyBonus: data.lastDailyBonus,
      });
      toast.success(data.message || "Бонус получен!");
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 400) {
        const data = err.response.data as { error?: string };
        toast.error(data.error || "Приходите завтра");
        await fetchBalance();
      } else {
        const message =
          axios.isAxiosError(err) && err.response?.data?.error
            ? err.response.data.error
            : "Не удалось получить бонус";
        toast.error(message);
      }
    } finally {
      setClaiming(false);
    }
  };

  const totalCoins = balance?.realCoins ?? 0;
  const subscriptionCoins = 0;
  const personalCoins = totalCoins;
  const bonusAvailable = balance ? canClaimBonus(balance.lastDailyBonus) : false;
  const msUntilNext = balance ? getMsUntilNextBonus(balance.lastDailyBonus) : 0;

  return (
    <div className="min-h-dvh flex flex-col bg-wd-bg text-wd-text overflow-hidden">
      <Toaster position="top-right" />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-8 sm:px-6 lg:px-8 flex flex-col gap-10 overflow-y-auto scrollbar-subtle">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-wd-secondary">
            <FaCoins className="text-lg" />
            <span className="text-xs font-bold uppercase tracking-widest">RealCoins</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-white">Купить RealCoins</h1>
          <p className="text-sm text-wd-text-secondary max-w-xl">
            Выберите пакет токенов для общения с персонажами и генерации контента.
          </p>
        </div>

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {PACKAGES.map((pkg) => (
            <article
              key={pkg.id}
              className="relative flex flex-col rounded-wd border border-wd-border bg-wd-card p-6 shadow-wd transition-all hover:border-wd-secondary/40 hover:shadow-[0_12px_40px_rgba(108,99,255,0.1)]"
            >
              {pkg.badge && (
                <span className="absolute right-4 top-4 rounded-wd-pill border border-wd-primary/40 bg-wd-primary/15 px-3 py-1 text-xs font-black text-wd-primary">
                  {pkg.badge}
                </span>
              )}

              <div className="mb-4 flex items-center gap-2 text-wd-secondary">
                <FaCoins size={18} />
                <span className="text-xs font-bold uppercase tracking-wider">RealCoins</span>
              </div>

              <p className="text-4xl font-black text-white leading-none">{formatCoins(pkg.total)}</p>

              {pkg.base && pkg.bonus ? (
                <p className="mt-2 text-sm text-wd-text-secondary">
                  {formatCoins(pkg.base)}{" "}
                  <span className="text-wd-primary font-semibold">+ {formatCoins(pkg.bonus)} бонусом</span>
                </p>
              ) : (
                <p className="mt-2 text-sm text-wd-text-secondary">Без бонуса</p>
              )}

              <div className="mt-6 flex items-end justify-between gap-4 border-t border-wd-border pt-5">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-wd-text-secondary font-bold">Цена</p>
                  <p className="text-2xl font-black text-white">{formatCoins(pkg.price)} ₽</p>
                </div>
                <button
                  type="button"
                  onClick={handleBuy}
                  className="rounded-wd-pill border border-wd-secondary/40 bg-wd-secondary/15 px-5 py-2.5 text-sm font-bold text-white transition-all hover:bg-wd-secondary hover:border-wd-secondary"
                >
                  Купить
                </button>
              </div>
            </article>
          ))}
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-black text-white">Ваш баланс</h2>

          {status === "unauthenticated" && (
            <div className="wd-card p-8 text-center space-y-4">
              <FaCoins className="mx-auto text-3xl text-wd-secondary opacity-60" />
              <p className="text-sm text-wd-text-secondary">Войдите, чтобы видеть баланс и получать ежедневный бонус</p>
              <Link href="/login" className="wd-button inline-flex px-6 py-2.5 text-sm">
                Войти
              </Link>
            </div>
          )}

          {status === "authenticated" && loadingBalance && (
            <div className="wd-card flex items-center justify-center p-12">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
            </div>
          )}

          {status === "authenticated" && !loadingBalance && error && (
            <div className="wd-card border-wd-primary/30 p-8 text-center space-y-3">
              <p className="text-sm font-extrabold uppercase text-wd-primary">Ошибка</p>
              <p className="text-xs text-wd-text-secondary">{error}</p>
              <button type="button" onClick={fetchBalance} className="wd-button px-5 py-2.5 text-xs">
                Повторить
              </button>
            </div>
          )}

          {status === "authenticated" && !loadingBalance && !error && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="wd-card p-8 text-center space-y-4">
                <p className="text-xs font-bold uppercase tracking-widest text-wd-text-secondary">Всего RealCoins</p>
                <p className="text-5xl font-black text-white flex items-center justify-center gap-3">
                  <FaCoins className="text-wd-secondary" />
                  {formatCoins(totalCoins)}
                </p>
                <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-2 text-sm text-wd-text-secondary">
                  <span>
                    По подписке:{" "}
                    <strong className="text-white">{formatCoins(subscriptionCoins)}</strong>
                  </span>
                  <span className="hidden sm:inline text-wd-border">|</span>
                  <span>
                    Личные: <strong className="text-white">{formatCoins(personalCoins)}</strong>
                  </span>
                </div>
              </div>

              <div className="wd-card p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <FaGift className="text-wd-primary" />
                  <h3 className="text-base font-extrabold uppercase tracking-wide text-white">Ежедневный бонус</h3>
                </div>
                <p className="text-xs text-wd-text-secondary leading-relaxed">
                  Получайте +50 RealCoins каждые 24 часа.
                </p>

                {!bonusAvailable && balance?.lastDailyBonus && (
                  <div className="rounded-wd border border-wd-border bg-[#0A0A0A] p-3 text-xs text-wd-text-secondary">
                    <p className="font-semibold text-white">Бонус уже получен сегодня</p>
                    <p className="mt-1">
                      Следующий бонус через:{" "}
                      <span className="font-bold text-wd-secondary">{formatDuration(msUntilNext)}</span>
                    </p>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleClaimBonus}
                  disabled={claiming || !bonusAvailable}
                  className="wd-button flex w-full items-center justify-center gap-2 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FaGift />
                  {claiming ? "Получение..." : bonusAvailable ? "Получить бонус (+50)" : "Бонус недоступен"}
                </button>
              </div>
            </div>
          )}
        </section>
      </main>

      <Footer />
    </div>
  );
}
