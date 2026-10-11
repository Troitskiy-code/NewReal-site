export default function Logo({ className = "", size = "sm" }) {
  const sizeClasses = {
    sm: "text-sm",
    md: "text-xl",
    lg: "text-2xl",
    xl: "text-3xl",
  };

  return (
    <span
      className={`font-black uppercase tracking-wide bg-gradient-to-r from-wd-primary-soft via-wd-primary to-violet-500 bg-clip-text text-transparent ${sizeClasses[size] || sizeClasses.sm} ${className}`}
    >
      NewVerse
    </span>
  );
}
