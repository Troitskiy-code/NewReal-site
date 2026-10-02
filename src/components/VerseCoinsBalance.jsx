"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import { FaCoins } from "react-icons/fa";
import axios from "axios";
import { usePathname } from "next/navigation";
import { coinsHrefFromChat } from "@/lib/coinsReturn";

export default function VerseCoinsBalance({ className = "", size = "sm" }) {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const userId = session?.user?.id ?? null;
  const [balance, setBalance] = useState(null);
  useEffect(() => {
    if (status !== "authenticated" || !userId) return;
    const controller = new AbortController();
    const refresh = () => {
      axios.get("/api/user/balance", { signal: controller.signal }).then(({ data }) => {
        if (!controller.signal.aborted) setBalance({ userId, coins: data.verseCoins });
      }).catch(() => {});
    };
    refresh();
    window.addEventListener("verseCoinsUpdated", refresh);
    return () => { controller.abort(); window.removeEventListener("verseCoinsUpdated", refresh); };
  }, [status, userId]);
  const verseCoins = balance?.userId === userId ? balance.coins : null;
  if (status !== "authenticated" || verseCoins === null) return null;
  const sizeClasses = size === "md" ? "gap-2 px-4 py-2 text-sm" : "gap-1.5 px-2.5 py-1 text-xs md:px-3 md:py-1.5 md:text-sm";
  return <Link href={coinsHrefFromChat(pathname)}
    className={`inline-flex items-center rounded-full border border-[#2A2A2A] bg-[#0A0A0A]/80 font-bold text-white transition-colors hover:border-[#6C63FF]/50 ${sizeClasses} ${className}`} title="VerseCoins">
    <FaCoins className="shrink-0 text-[#6C63FF]" size={size === "md" ? "16" : "14"} />
    <span>{verseCoins.toLocaleString("ru-RU")} VC</span>
  </Link>;
}
