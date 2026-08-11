"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";
import { FaCoins } from "react-icons/fa";
import axios from "axios";

export default function VerseCoinsBalance({ className = "", size = "sm" }) {
  const { status } = useSession();
  const [verseCoins, setVerseCoins] = useState(null);

  const fetchBalance = useCallback(() => {
    if (status !== "authenticated") {
      setVerseCoins(null);
      return;
    }

    axios
      .get("/api/user/balance")
      .then(({ data }) => setVerseCoins(data.verseCoins))
      .catch(() => setVerseCoins(null));
  }, [status]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  useEffect(() => {
    const onBalanceUpdate = (event) => {
      const detail = event?.detail;
      if (typeof detail?.verseCoins === "number") {
        setVerseCoins(detail.verseCoins);
      } else {
        fetchBalance();
      }
    };

    window.addEventListener("verseCoinsUpdated", onBalanceUpdate);
    return () => window.removeEventListener("verseCoinsUpdated", onBalanceUpdate);
  }, [fetchBalance]);

  if (status !== "authenticated" || verseCoins === null) {
    return null;
  }

  const sizeClasses =
    size === "md"
      ? "gap-2 px-4 py-2 text-sm"
      : "gap-1.5 px-2.5 py-1 text-xs md:px-3 md:py-1.5 md:text-sm";

  return (
    <Link
      href="/coins"
      className={`inline-flex items-center rounded-full border border-[#2A2A2A] bg-[#0A0A0A]/80 font-bold text-white transition-colors hover:border-[#6C63FF]/50 ${sizeClasses} ${className}`}
      title="VerseCoins"
    >
      <FaCoins className="shrink-0 text-[#6C63FF]" size={size === "md" ? 16 : 14} />
      <span>{verseCoins.toLocaleString("ru-RU")} VC</span>
    </Link>
  );
}
