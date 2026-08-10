export default function Logo({ className = "", size = "sm" }) {
  const sizeClasses = {
    sm: "text-sm",
    md: "text-xl",
    lg: "text-2xl",
    xl: "text-3xl",
  };

  return (
    <span
      className={`font-black uppercase tracking-wide bg-gradient-to-r from-orange-400 via-pink-500 to-purple-600 bg-clip-text text-transparent ${sizeClasses[size] || sizeClasses.sm} ${className}`}
    >
      NewReal
    </span>
  );
}
