"use client";

type LoadErrorBlockProps = {
  message: string;
  onRetry: () => void;
};

export default function LoadErrorBlock({ message, onRetry }: LoadErrorBlockProps) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-[#0A0A0A] p-6 text-center">
      <p className="text-sm font-semibold text-red-400">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-full border border-[#2A2A2A] px-4 py-2 text-xs font-semibold text-white transition-colors hover:border-[#6C63FF]"
      >
        Повторить
      </button>
    </div>
  );
}
