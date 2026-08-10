"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import Footer from "@/components/Footer";
import axios from "axios";
import toast, { Toaster } from "react-hot-toast";
import { FaUserFriends, FaCopy, FaCoins } from "react-icons/fa";

type ReferralStats = {
  count: number;
  referralCode: string;
};

const REFERRAL_REWARD = 100;

export default function ReferralPage() {
  const { status } = useSession();
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [referralLink, setReferralLink] = useState("");

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.get<ReferralStats>("/api/referral/stats");
      setStats(data);
      setReferralLink(`${window.location.origin}/register?ref=${data.referralCode}`);
    } catch (err) {
      const message =
        axios.isAxiosError(err) && err.response?.data?.error
          ? err.response.data.error
          : "Не удалось загрузить статистику";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      fetchStats();
    } else if (status === "unauthenticated") {
      setLoading(false);
    }
  }, [status, fetchStats]);

  const handleCopyLink = async () => {
    if (!referralLink) return;
    try {
      await navigator.clipboard.writeText(referralLink);
      toast.success("Ссылка скопирована!");
    } catch {
      toast.error("Не удалось скопировать ссылку");
    }
  };

  const earnedCoins = stats ? stats.count * REFERRAL_REWARD : 0;

  if (status === "loading" || (status === "authenticated" && loading)) {
    return (
      <div className="min-h-dvh flex flex-col bg-bg-page text-primary-text">
        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
        <Footer />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return (
      <div className="min-h-dvh flex flex-col bg-bg-page text-primary-text">
        <Toaster position="top-right" />
        <main className="flex-1 flex flex-col items-center justify-center px-4 py-12 text-center gap-4">
          <FaUserFriends className="text-4xl opacity-30 text-primary" />
          <h1 className="text-xl font-black uppercase tracking-tight">Реферальная программа</h1>
          <p className="text-xs text-secondary-text max-w-sm">Войдите, чтобы получить реферальную ссылку</p>
          <Link
            href="/login"
            className="bg-primary text-white px-6 py-2.5 rounded-full text-sm font-bold hover:bg-primary-hover transition-all"
          >
            Войти
          </Link>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col bg-bg-page select-none text-primary-text overflow-hidden">
      <Toaster position="top-right" />
      <main className="flex-1 max-w-lg w-full mx-auto px-4 py-8 sm:px-6 lg:px-8 flex flex-col gap-6 overflow-y-auto scrollbar-subtle">
        <div className="space-y-1 border-b border-divider/40 pb-4">
          <h1 className="text-2xl font-black tracking-tight uppercase flex items-center gap-2">
            <FaUserFriends className="text-primary" />
            Реферальная программа
          </h1>
          <p className="text-xs text-secondary-text">
            Приглашайте друзей и получайте {REFERRAL_REWARD} RealCoins за каждую регистрацию
          </p>
        </div>

        {error ? (
          <div className="flex flex-col items-center text-center py-12 bg-bg-card/20 rounded border border-red-500/30 gap-3">
            <p className="text-sm font-extrabold uppercase text-red-500">Ошибка</p>
            <p className="text-xs text-secondary-text">{error}</p>
            <button
              type="button"
              onClick={fetchStats}
              className="bg-primary hover:bg-primary-hover text-white px-5 py-2 rounded-full text-xs font-bold transition-all"
            >
              Повторить
            </button>
          </div>
        ) : (
          <>
            <div className="border border-divider/40 bg-bg-card/30 rounded-lg p-6 space-y-3">
              <p className="text-xs font-bold text-secondary-text uppercase tracking-widest">Ваша реферальная ссылка</p>
              <p className="text-xs text-primary-text break-all bg-bg-page border border-divider rounded-lg p-3 font-medium">
                {referralLink || "—"}
              </p>
              <button
                type="button"
                onClick={handleCopyLink}
                disabled={!referralLink}
                className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover disabled:bg-primary/40 text-white font-bold py-3 rounded-full text-xs shadow-lg transition-all"
              >
                <FaCopy className="text-sm" />
                Копировать ссылку
              </button>
              {stats?.referralCode && (
                <p className="text-[10px] text-secondary-text text-center">
                  Ваш код: <span className="font-bold text-primary">{stats.referralCode}</span>
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="border border-divider/40 bg-bg-card/30 rounded-lg p-5 text-center space-y-1">
                <p className="text-xs font-bold text-secondary-text uppercase tracking-widest">Приглашено</p>
                <p className="text-3xl font-black text-primary">{stats?.count ?? 0}</p>
              </div>
              <div className="border border-divider/40 bg-bg-card/30 rounded-lg p-5 text-center space-y-1">
                <p className="text-xs font-bold text-secondary-text uppercase tracking-widest">Заработано</p>
                <p className="text-3xl font-black text-amber-400 flex items-center justify-center gap-1.5">
                  <FaCoins className="text-lg" />
                  {earnedCoins}
                </p>
              </div>
            </div>
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}
