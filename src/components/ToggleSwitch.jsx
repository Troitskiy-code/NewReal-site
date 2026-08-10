"use client";

export default function ToggleSwitch({
  isOn,
  onToggle,
  label,
  disabled = false,
  labelPosition = "left",
  compact = false,
}) {
  return (
    <div
      className={`inline-flex items-center gap-2 ${compact ? "gap-1.5" : "gap-2.5"} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      {label && labelPosition === "left" && (
        <span
          className={`select-none text-gray-400 ${compact ? "whitespace-nowrap text-xs" : "text-sm"}`}
        >
          {label}
        </span>
      )}

      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        aria-label={label || "Переключатель"}
        disabled={disabled}
        onClick={() => {
          if (!disabled) onToggle(!isOn);
        }}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-all duration-200 ${
          isOn ? "bg-[#6C63FF]" : "bg-[#2A2A2A]"
        } ${disabled ? "pointer-events-none" : "cursor-pointer"}`}
      >
        <span
          className={`absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-md transition-transform duration-200 ${
            isOn ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>

      {label && labelPosition === "right" && (
        <span
          className={`select-none text-gray-400 ${compact ? "whitespace-nowrap text-xs" : "text-sm"}`}
        >
          {label}
        </span>
      )}
    </div>
  );
}
