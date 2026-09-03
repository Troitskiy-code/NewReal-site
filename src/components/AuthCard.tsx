import type { ReactNode } from "react";

export const AUTH_INPUT_CLASS =
  "w-full border-0 border-b border-divider bg-[#0A0A0A] px-4 py-3 text-white placeholder:text-wd-text-secondary outline-none transition-colors focus:border-primary";

export const AUTH_BUTTON_CLASS =
  "w-full rounded-wd-pill bg-primary py-3 font-bold text-white transition hover:bg-primary-hover disabled:opacity-50";

export const AUTH_GOOGLE_BUTTON_CLASS =
  "flex w-full items-center justify-center gap-2 rounded-wd-pill border border-wd-secondary/40 bg-[#12101c] py-3 font-semibold text-white transition hover:border-wd-secondary hover:bg-[#1a1630]";

export function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export function GoogleAuthButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <a href="/api/auth/signin/google?callbackUrl=/" onClick={onClick} className={AUTH_GOOGLE_BUTTON_CLASS}>
      <GoogleIcon />
      {children}
    </a>
  );
}

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
