export default function PricingLoading() {
  return (
    <div className="flex min-h-dvh flex-col overflow-hidden bg-wd-bg text-wd-text">
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-center gap-10 overflow-y-auto px-4 py-12 scrollbar-subtle sm:px-6 lg:px-8">
        <div className="flex w-full flex-col items-center gap-4 text-center">
          <div className="h-6 w-28 animate-pulse rounded-wd-pill bg-white/10" />
          <div className="h-10 w-64 animate-pulse rounded bg-white/10 sm:w-80" />
          <div className="h-4 w-full max-w-xl animate-pulse rounded bg-white/10" />
        </div>
        <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              className="flex flex-col rounded-wd border border-wd-border bg-wd-card p-6 shadow-wd"
            >
              <div className="mb-5 flex items-center gap-3">
                <div className="h-11 w-11 animate-pulse rounded-wd bg-white/10" />
                <div className="space-y-2">
                  <div className="h-5 w-24 animate-pulse rounded bg-white/10" />
                  <div className="h-3 w-16 animate-pulse rounded bg-white/10" />
                </div>
              </div>
              <div className="h-8 w-28 animate-pulse rounded bg-white/10" />
              <div className="mt-6 space-y-3">
                <div className="h-3 w-full animate-pulse rounded bg-white/10" />
                <div className="h-3 w-5/6 animate-pulse rounded bg-white/10" />
                <div className="h-3 w-4/5 animate-pulse rounded bg-white/10" />
              </div>
              <div className="mt-8 h-11 w-full animate-pulse rounded-wd-pill bg-white/10" />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
