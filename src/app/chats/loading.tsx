export default function ChatsLoading() {
  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-[#121212] text-wd-text">
      <div className="mb-2 w-full border-b border-[#2A2A2A] px-4 py-3 md:py-4">
        <div className="space-y-2">
          <div className="h-7 w-36 animate-pulse rounded bg-white/10" />
          <div className="h-3 w-56 animate-pulse rounded bg-white/10" />
        </div>
      </div>
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 pb-6 pt-2 md:gap-4 md:px-6 md:pt-4">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 rounded-xl border border-[#2A2A2A] bg-[#1A1A1A] p-3 md:gap-4 md:p-4"
          >
            <div className="h-14 w-14 shrink-0 animate-pulse rounded-full bg-white/10 md:h-16 md:w-16" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="h-4 w-32 animate-pulse rounded bg-white/10" />
                <div className="h-3 w-12 animate-pulse rounded bg-white/10" />
              </div>
              <div className="h-3 w-full max-w-sm animate-pulse rounded bg-white/10" />
              <div className="h-3 w-20 animate-pulse rounded bg-white/10" />
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}
