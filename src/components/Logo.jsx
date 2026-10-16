/** Four-point star with a red "satellite": the NewVerse mark. Inherits the text color. */
export function LogoMark({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path d="M12 1.5 L13.9 10.1 L22.5 12 L13.9 13.9 L12 22.5 L10.1 13.9 L1.5 12 L10.1 10.1 Z" fill="currentColor" />
      <circle cx="19.5" cy="4.5" r="1.6" className="fill-wd-primary" />
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
