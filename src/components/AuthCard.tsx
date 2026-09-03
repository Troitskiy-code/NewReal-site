import type { ReactNode } from "react";

export const AUTH_INPUT_CLASS =
  "w-full border-0 border-b border-divider bg-[#0A0A0A] px-4 py-3 text-white placeholder:text-wd-text-secondary outline-none transition-colors focus:border-primary";

export const AUTH_BUTTON_CLASS =
  "w-full rounded-wd-pill bg-primary py-3 font-bold text-white transition hover:bg-primary-hover disabled:opacity-50";

export function AuthCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center bg-wd-bg px-4 py-8 text-wd-text md:min-h-[calc(100dvh-5rem)]">
      <div className="w-full max-w-md rounded-wd border border-divider bg-wd-card p-8 shadow-wd">
        <h1 className="mb-6 text-3xl font-bold text-white">{title}</h1>
        {children}
      </div>
    </div>
  );
}
