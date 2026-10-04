"use client";

import type { ComponentPropsWithoutRef } from "react";

type PurchaseButtonProps = ComponentPropsWithoutRef<"button"> & {
  busy?: boolean;
};

export default function PurchaseButton({
  busy = false,
  disabled,
  className = "",
  children,
  type = "button",
  ...props
}: PurchaseButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy}
      className={`inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-transparent bg-wd-primary px-5 py-3 text-sm font-bold leading-5 text-white transition-[background-color,box-shadow,transform] hover:bg-[#e0264b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wd-secondary focus-visible:ring-offset-2 focus-visible:ring-offset-wd-bg active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-wd-primary disabled:active:scale-100 motion-reduce:transform-none motion-reduce:transition-none ${className}`}
    >
      {busy && <span aria-hidden className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none" />}
      {children}
    </button>
  );
}
