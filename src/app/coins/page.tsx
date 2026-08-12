"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import Footer from "@/components/Footer";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";
import { FaCoins, FaCrown, FaGift } from "react-icons/fa";
import { DAILY_BONUS_AMOUNTS } from "@/lib/dailyBonus";

type BalanceData = {
  verseCoins: number;
  bonusStreak: number;
  lastBonusDate: string | null;
  canClaimBonus: boolean;
  currentBonusAmount: number;
  nextBonus: number;
  msUntilNextBonus: number;
  subscriptionActive: boolean;
  subscriptionLabel: string | null;
  subscriptionEnd: string | null;
  freeRequestsRemaining: number | null;
  freeRequestsLimit: number;
};

type TokenPackage = {
  id: number;
  vc: number;
  price: number;
  bonus?: string;
};

const PACKAGES: TokenPackage[] = [
  { id: 1, vc: 1000, price: 300 },
  { id: 2, vc: 2500, price: 600, bonus: "+20%" },
  { id: 3, vc: 7000, price: 1500, bonus: "+40%" },
  { id: 4, vc: 16000, price: 3000, bonus: "+60%" },
  { id: 5, vc: 35000, price: 6000, bonus: "+80%" },
  { id: 6, vc: 100000, price: 15000, bonus: "+100%" },
];

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

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export default function CoinsPage() {
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

  const handleBuy = async (price: number, coins: number) => {
    try {
      const res = await fetch("/api/payment/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sum: price,
          desc: `Покупка ${coins} VC`,
        }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        toast.error("Не удалось создать платёж");
      }
    } catch (error) {
      toast.error("Ошибка при создании платежа");
    }
  };

  const handleClaimBonus = async () => {
    setClaiming(true);
    try {
      const { data } = await axios.post<{ message: string; verseCoins: number }>("/api/daily-bonus");
      toast.success(data.message || "Бонус получен!");
      window.dispatchEvent(
        new CustomEvent("verseCoinsUpdated", { detail: { verseCoins: data.verseCoins } })
      );
      await fetchBalance();
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

  const streakDay = balance?.canClaimBonus
    ? Math.min((balance.bonusStreak % 7) + 1, 7)
    : Math.min(Math.max(balance?.bonusStreak ?? 0, 1), 7);
  const streakProgress = balance ? (Math.min(balance.bonusStreak, 7) / 7) * 100 : 0;

  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-wd-bg text-wd-text">
      <Toaster position="top-right" />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-10 overflow-y-auto px-4 py-8 scrollbar-subtle sm:px-6 lg:px-8">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-wd-secondary">
            <FaCoins className="text-lg" />
            <span className="text-xs font-bold uppercase tracking-widest">VerseCoins</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-white">VerseCoins (VC)</h1>
          <p className="max-w-xl text-sm text-wd-text-secondary">
            Покупайте VC для общения с персонажами, получайте ежедневный бонус и следите за подпиской.
          </p>
        </div>

        {status === "unauthenticated" && (
          <div className="wd-card space-y-4 p-8 text-center">
            <FaCoins className="mx-auto text-3xl text-wd-secondary opacity-60" />
            <p className="text-sm text-wd-text-secondary">
              Войдите, чтобы видеть баланс, бонусы и покупать VC
            </p>
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
          <div className="wd-card space-y-3 border-wd-primary/30 p-8 text-center">
            <p className="text-sm font-extrabold uppercase text-wd-primary">Ошибка</p>
            <p className="text-xs text-wd-text-secondary">{error}</p>
            <button type="button" onClick={fetchBalance} className="wd-button px-5 py-2.5 text-xs">
              Повторить
            </button>
          </div>
        )}

        {status === "authenticated" && !loadingBalance && !error && balance && (
          <>
            <section className="wd-card p-8 text-center">
              <p className="text-xs font-bold uppercase tracking-widest text-wd-text-secondary">
                Текущий баланс
              </p>
              <p className="mt-3 flex items-center justify-center gap-3 text-5xl font-black text-white">
                <FaCoins className="text-wd-secondary" />
                {formatCoins(balance.verseCoins)} VC
              </p>
            </section>

            {balance.subscriptionActive && balance.subscriptionLabel && balance.subscriptionEnd && (
              <section className="wd-card flex items-start gap-3 border-wd-secondary/30 p-5">
                <FaCrown className="mt-1 shrink-0 text-wd-secondary" />
                <div>
                  <p className="text-sm font-bold text-white">Ваша подписка: {balance.subscriptionLabel}</p>
                  <p className="mt-1 text-xs text-wd-text-secondary">
                    Действует до {formatDate(balance.subscriptionEnd)}
                  </p>
                </div>
              </section>
            )}

            {!balance.subscriptionActive && balance.freeRequestsRemaining !== null && (
              <section className="rounded-wd border border-wd-border bg-[#121212] px-5 py-4 text-sm text-wd-text-secondary">
                У вас осталось{" "}
                <strong className="text-white">{balance.freeRequestsRemaining}</strong> бесплатных запросов в
                этом месяце (из {balance.freeRequestsLimit}).
              </section>
            )}

            <section className="wd-card space-y-5 p-6">
              <div className="flex items-center gap-2">
                <FaGift className="text-wd-primary" />
                <h2 className="text-base font-extrabold uppercase tracking-wide text-white">
                  Ежедневный бонус
                </h2>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-wd-text-secondary">
                  <span>День серии: {streakDay} / 7</span>
                  <span>
                    Сегодня:{" "}
                    <strong className="text-white">
                      +{balance.canClaimBonus ? balance.currentBonusAmount : balance.nextBonus} VC
                    </strong>
                  </span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-[#0A0A0A]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-wd-primary to-wd-secondary transition-all"
                    style={{ width: `${Math.max(streakProgress, balance.bonusStreak > 0 ? 8 : 0)}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-wd-text-secondary">
                  {DAILY_BONUS_AMOUNTS.map((amount, index) => (
                    <span key={amount} className={index + 1 <= balance.bonusStreak ? "text-wd-primary" : ""}>
                      {amount}
                    </span>
                  ))}
                </div>
              </div>

              {!balance.canClaimBonus && (
                <div className="rounded-wd border border-wd-border bg-[#0A0A0A] p-3 text-xs text-wd-text-secondary">
                  <p className="font-semibold text-white">Бонус уже получен сегодня</p>
                  <p className="mt-1">
                    Следующий бонус через:{" "}
                    <span className="font-bold text-wd-secondary">
                      {formatDuration(balance.msUntilNextBonus)}
                    </span>{" "}
                    (+{balance.nextBonus} VC)
                  </p>
                </div>
              )}

              <button
                type="button"
                onClick={handleClaimBonus}
                disabled={claiming || !balance.canClaimBonus}
                className="wd-button flex w-full items-center justify-center gap-2 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FaGift />
                {claiming
                  ? "Получение..."
                  : balance.canClaimBonus
                    ? `Получить (+${balance.currentBonusAmount} VC)`
                    : "Бонус недоступен"}
              </button>
            </section>
          </>
        )}

        <section className="space-y-4">
          <h2 className="text-xl font-black text-white">Пакеты VC</h2>
          <div className="overflow-x-auto rounded-wd border border-wd-border">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-wd-border bg-[#121212] text-xs uppercase tracking-wider text-wd-text-secondary">
                <tr>
                  <th className="px-4 py-3 font-bold">VC</th>
                  <th className="px-4 py-3 font-bold">Цена (₽)</th>
                  <th className="px-4 py-3 font-bold">Бонус</th>
                  <th className="px-4 py-3 font-bold text-right">Действие</th>
                </tr>
              </thead>
              <tbody>
                {PACKAGES.map((pkg) => (
                  <tr key={pkg.id} className="border-b border-wd-border/60 bg-wd-card last:border-b-0">
                    <td className="px-4 py-4 font-black text-white">{formatCoins(pkg.vc)}</td>
                    <td className="px-4 py-4 text-white">{formatCoins(pkg.price)}</td>
                    <td className="px-4 py-4">
                      {pkg.bonus ? (
                        <span className="rounded-wd-pill border border-wd-primary/40 bg-wd-primary/15 px-2.5 py-1 text-xs font-bold text-wd-primary">
                          {pkg.bonus}
                        </span>
                      ) : (
                        <span className="text-wd-text-secondary">–</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <button
                        type="button"
                        onClick={() => handleBuy(pkg.price, pkg.vc)}
                        className="rounded-wd-pill border border-wd-secondary/40 bg-wd-secondary/15 px-4 py-2 text-xs font-bold text-white transition-all hover:border-wd-secondary hover:bg-wd-secondary"
                      >
                        Купить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
