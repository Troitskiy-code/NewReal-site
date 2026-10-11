import type { ReactNode } from "react";
import Footer from "./Footer";

// Full-height fallback for the 404 and error pages; actions are passed in so it works on server and client.
export default function ErrorState({
  code,
  title,
  text,
  children,
  note,
}: {
  code: string;
  title: string;
  text: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col bg-wd-bg text-wd-text">
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-20 text-center">
        <p
          aria-hidden
          className="bg-gradient-to-r from-wd-primary to-wd-secondary bg-clip-text text-7xl font-black leading-none tracking-tight text-transparent sm:text-8xl"
        >
          {code}
        </p>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-white sm:text-3xl">{title}</h1>
        <p className="mt-3 max-w-md text-[15px] leading-relaxed text-wd-text-secondary">{text}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">{children}</div>
        {note && <p className="mt-6 text-xs text-wd-text-secondary">{note}</p>}
      </main>
      <Footer />
    </div>
  );
}

export const ERROR_PRIMARY_BUTTON =
  "inline-flex min-h-12 items-center justify-center rounded-full bg-wd-primary px-6 text-[15px] font-semibold text-white transition-colors hover:bg-wd-primary-hover";
export const ERROR_SECONDARY_BUTTON =
  "inline-flex min-h-12 items-center justify-center rounded-full border border-white/20 px-6 text-[15px] font-semibold text-white transition-colors hover:border-white/40 hover:bg-white/5";
