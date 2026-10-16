"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import { LogoMark } from "./Logo";
import axios from "axios";
import { usePathname } from "next/navigation";
import { coinsHrefFromChat } from "@/lib/coinsReturn";
import { useTelegramMode } from "./TelegramProvider";

export default function VerseCoinsBalance({ className = "", size = "sm" }) {
  const pathname = usePathname();
  const telegram = useTelegramMode();
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
  const content = <>
    <LogoMark className={`shrink-0 text-wd-secondary ${size === "md" ? "h-4 w-4" : "h-3.5 w-3.5"} [&_circle]:hidden`} />
    <span>{verseCoins.toLocaleString("ru-RU")} VC</span>
  </>;
  // In Telegram the balance is shown, but it does not lead to the shop.
  if (telegram) return <span data-testid="vc-balance"
    className={`inline-flex items-center rounded-full border border-wd-secondary/25 bg-wd-secondary/10 font-bold text-wd-secondary ${sizeClasses} ${className}`} title="VerseCoins">{content}</span>;
  return <Link href={coinsHrefFromChat(pathname)}
    className={`inline-flex items-center rounded-full border border-wd-secondary/25 bg-wd-secondary/10 font-bold text-wd-secondary transition-colors hover:border-wd-secondary/50 ${sizeClasses} ${className}`} title="VerseCoins">
    {content}
  </Link>;
}
