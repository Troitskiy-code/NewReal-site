import type { Faq } from "@/lib/landingTexts";

/** Answers stay in the HTML (closed <details>), so crawlers read them without a click. */
export default function LandingFaq({ heading, items }: { heading: string; items: Faq[] }) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-lg font-semibold text-white md:text-xl">{heading}</h2>
      <div className="divide-y divide-wd-border overflow-hidden rounded-2xl border border-wd-border bg-wd-card">
        {items.map((item) => (
          <details key={item.question} className="group px-4 py-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-semibold text-white [&::-webkit-details-marker]:hidden">
              {item.question}
              <span aria-hidden className="shrink-0 text-wd-text-secondary transition-transform group-open:rotate-45">+</span>
            </summary>
            <p className="mt-2 text-[14px] leading-relaxed text-wd-text/85">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
