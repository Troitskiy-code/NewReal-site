"use client";

import { openOutsideTelegram } from "@/components/TelegramProvider";

export function OpenOutsideButton({ href, label }: { href: string; label: string }) {
  return (
    <button type="button" onClick={() => openOutsideTelegram(href)} className="wd-button px-5 py-3 text-sm">
      {label}
    </button>
  );
}
