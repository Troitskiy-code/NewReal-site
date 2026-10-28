"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";
import { FaCoins, FaGift } from "react-icons/fa";
import { showError, showSuccess } from "@/lib/toast";

// Balance and daily bonus without any purchase element (Telegram Mini App).
type Balance = { verseCoins: number; canClaimBonus: boolean; currentBonusAmount: number; nextBonus: number };

async function fetchBalance(signal?: AbortSignal): Promise<Balance | null> {
  try {
    const response = await fetch("/api/user/balance", { signal, cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

export default function DailyBonusCard({ showBalance = true }: { showBalance?: boolean }) {
  const { status } = useSession();
  const { t, i18n } = useTranslation();
  const [balance, setBalance] = useState<Balance | null>(null);
  const [failed, setFailed] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const apply = useCallback((data: Balance | null, signal?: AbortSignal) => {
    if (signal?.aborted) return;
    if (data) setBalance(data);
    setFailed(!data);
  }, []);
  const refresh = useCallback(async () => apply(await fetchBalance()), [apply]);

  useEffect(() => {
    if (status !== "authenticated") return;
    const controller = new AbortController();
    const update = () => { void fetchBalance(controller.signal).then((data) => apply(data, controller.signal)); };
    update();
    window.addEventListener("verseCoinsUpdated", update);
    return () => { controller.abort(); window.removeEventListener("verseCoinsUpdated", update); };
  }, [status, apply]);

  if (status !== "authenticated") return null;

  const claim = async () => {
    setClaiming(true);
    try {
      const response = await fetch("/api/daily-bonus", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("coins.bonusError"));
      showSuccess(data.message || t("coins.bonusReceived"));
      window.dispatchEvent(new CustomEvent("verseCoinsUpdated", { detail: { verseCoins: data.verseCoins } }));
    } catch (error) {
      showError(error instanceof Error ? error.message : t("coins.bonusError"));
    }
    await refresh();
    setClaiming(false);
  };

  const number = (value: number) => value.toLocaleString(i18n.language);

  return (
    <section data-testid="daily-bonus-card" aria-labelledby="daily-bonus-title" className="wd-card space-y-4 p-4 md:p-6">
      {showBalance && (
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-wd-text-secondary">
            <FaCoins className="text-wd-secondary-text" /> {t("coins.balance")}
          </span>
          <span className="text-xl font-black text-white">
            {balance ? `${number(balance.verseCoins)} VC` : failed ? "—" : "…"}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <FaGift className="text-wd-primary-soft" />
        <h2 id="daily-bonus-title" className="text-base font-bold text-white">{t("coins.dailyBonus")}</h2>
      </div>
      {balance && !balance.canClaimBonus && <p className="text-xs text-wd-text-secondary">{t("coins.alreadyClaimed")}</p>}
      <button
        type="button"
        onClick={claim}
        disabled={claiming || !balance?.canClaimBonus}
        className="wd-button flex w-full items-center justify-center gap-2 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        <FaGift />
        {claiming
          ? t("coins.claiming")
          : balance?.canClaimBonus
            ? t("coins.claim", { amount: balance.currentBonusAmount })
            : balance
              ? t("telegram.bonusTomorrow", { amount: balance.nextBonus })
              : t("coins.dailyBonus")}
      </button>
      {failed && (
        <button type="button" onClick={() => { void refresh(); }} className="text-sm text-wd-secondary-text underline">
          {t("common.retry")}
        </button>
      )}
    </section>
  );
}
