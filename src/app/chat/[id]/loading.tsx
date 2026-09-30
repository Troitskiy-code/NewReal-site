export default function ChatLoading() {
  return (
    <div className="relative z-10 flex h-[calc(100dvh-3.5rem)] max-h-[calc(100dvh-3.5rem)] min-h-0 max-w-full flex-col overflow-hidden overscroll-none bg-bg-page text-primary-text md:h-[calc(100dvh-5rem)] md:max-h-[calc(100dvh-5rem)]">
      <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
        <main className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-3 px-4 py-2">
            <div className="h-10 w-10 animate-pulse rounded-full bg-white/10" />
            <div className="h-4 w-32 animate-pulse rounded bg-white/10" />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className="mx-auto flex w-full max-w-3xl flex-col space-y-3 px-4 pb-3 pt-4">
              <div className="h-16 w-3/4 animate-pulse rounded-2xl bg-white/10" />
              <div className="ml-auto h-16 w-2/3 animate-pulse rounded-2xl bg-white/10" />
              <div className="h-20 w-4/5 animate-pulse rounded-2xl bg-white/10" />
            </div>
          </div>
          <div className="shrink-0 px-3 py-3 md:p-4">
            <div className="mx-auto h-11 w-full max-w-3xl animate-pulse rounded-2xl bg-white/10" />
          </div>
        </main>
      </div>
    </div>
  );
}
