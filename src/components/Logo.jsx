import { BRAND_PATHS, BRAND_VIEW_BOX } from "@/lib/brand.mjs";

/** The approved story ribbon; monochrome is useful for decorative watermarks. */
export function LogoMark({ className = "", monochrome = false }) {
  return (
    <svg viewBox={BRAND_VIEW_BOX} aria-hidden="true" focusable="false" className={className}>
      {BRAND_PATHS.map(({ d, accent }, index) => (
        <path key={index} d={d} fill="currentColor" className={accent && !monochrome ? "fill-wd-primary" : undefined} />
      ))}
    </svg>
  );
}

/** VerseCoins keep their currency symbol independently of the NewVerse brand. */
export function VerseCoinMark({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path d="M12 1.5 L13.9 10.1 L22.5 12 L13.9 13.9 L12 22.5 L10.1 13.9 L1.5 12 L10.1 10.1 Z" fill="currentColor" />
    </svg>
  );
}

export default function Logo({ className = "", size = "sm" }) {
  const sizeClasses = {
    sm: "text-sm",
    md: "text-xl",
    lg: "text-2xl",
    xl: "text-3xl",
  };

  return (
    <span className={`font-display font-bold lowercase tracking-tight text-wd-text ${sizeClasses[size] || sizeClasses.sm} ${className}`}>
      newverse
    </span>
  );
}
