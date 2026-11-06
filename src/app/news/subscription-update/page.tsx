import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FaArrowLeft, FaArrowRight } from "react-icons/fa";
import Footer from "@/components/Footer";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { withLocale } from "@/lib/i18nConfig";
import {
  ANNOUNCED_SUBSCRIPTIONS,
  formatSubscriptionUpdateDate,
  subscriptionUpdateCopy,
  subscriptionUpdateState,
} from "@/lib/subscriptionUpdate";
import { isTelegramContext } from "@/lib/telegram/context";

export async function generateMetadata(): Promise<Metadata> {
  const copy = subscriptionUpdateCopy(await getRequestLocale());
  return {
    title: `${copy.title} · NewVerse`,
    description: copy.intro,
    robots: { index: false, follow: true },
  };
}

export default async function SubscriptionUpdatePage() {
  const { date, dateTime, isPreview } = subscriptionUpdateState();
  if ((!date && !isPreview) || await isTelegramContext()) notFound();

  const locale = await getRequestLocale();
  const copy = subscriptionUpdateCopy(locale);
  const intl = copy.lang === "ru" ? "ru-RU" : "en";
  const number = new Intl.NumberFormat(intl);
  const rubles = new Intl.NumberFormat(intl, { style: "currency", currency: "RUB", maximumFractionDigits: 0 });

  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 md:py-12">
        <article lang={copy.lang} className="space-y-10 md:space-y-12">
          <Link href={withLocale("/", locale)} className="inline-flex items-center gap-2 text-sm font-semibold text-wd-text-secondary hover:text-white">
            <FaArrowLeft aria-hidden className="text-xs" />{copy.back}
          </Link>
          <header className="relative overflow-hidden rounded-wd border border-wd-secondary/30 bg-wd-card bg-[radial-gradient(ellipse_at_top_right,#442532,transparent_65%)] p-5 sm:p-8 md:p-10">
            <p className="text-xs font-bold uppercase tracking-wider text-wd-secondary-text">{copy.eyebrow}</p>
            <p className="mt-3 inline-flex rounded-full border border-wd-secondary/30 bg-wd-bg/60 px-3 py-1.5 text-xs font-semibold text-wd-text">
              {date && dateTime ? <>{copy.starts} <time className="ml-1" dateTime={dateTime}>{formatSubscriptionUpdateDate(date, copy.lang)}</time></> : copy.preview}
            </p>
            <h1 className="mt-5 max-w-3xl font-display text-3xl font-semibold leading-tight text-white sm:text-4xl lg:text-5xl">{copy.title}</h1>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-wd-text/90 md:text-lg">{copy.intro}</p>
            <dl className="mt-7 grid gap-4 border-t border-wd-secondary/20 pt-5 sm:grid-cols-[1fr_2fr]">
              <div>
                <dt className="text-xs font-medium text-wd-text-secondary">{copy.priceLabel}</dt>
                <dd className="mt-1 text-lg font-bold text-wd-secondary-text">{copy.priceText}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-wd-text-secondary">{copy.modelLabel}</dt>
                <dd className="mt-1 text-base font-bold text-white">{copy.modelText}</dd>
              </div>
            </dl>
          </header>

          <section aria-labelledby="new-plans" className="space-y-4">
            <h2 id="new-plans" className="font-display text-xl font-semibold text-white md:text-2xl">{copy.pricingHeading}</h2>
            <p className="max-w-3xl text-sm leading-relaxed text-wd-text-secondary md:text-base">{copy.pricingText}</p>
            <div className="grid gap-4 md:grid-cols-3">
              {ANNOUNCED_SUBSCRIPTIONS.map((plan) => (
                <section key={plan.id} className={`flex flex-col rounded-wd border bg-wd-card p-5 ${plan.id === "story" ? "border-wd-secondary/45" : "border-wd-border"}`}>
                  <h3 className="text-lg font-extrabold text-white">{copy.plans[plan.id].name}</h3>
                  <p className="mt-1 flex-1 text-sm leading-relaxed text-wd-text-secondary">{copy.plans[plan.id].description}</p>
                  <p className="mt-4 text-xs text-wd-text-secondary">{copy.previous} <del>{rubles.format(plan.oldMonthly)} {copy.month}</del></p>
                  <p className="mt-1 text-sm text-wd-text-secondary">
                    <strong className="mr-1 text-3xl font-black text-white">{rubles.format(plan.monthly)}</strong> {copy.month}
                  </p>
                  <p className="mt-1 text-sm text-wd-text-secondary">{rubles.format(plan.yearly)} {copy.year}</p>
                  <ul className="mt-4 space-y-1.5 border-t border-wd-border pt-4 text-sm text-wd-text">
                    <li><strong className="text-wd-secondary-text">{number.format(plan.vc)}</strong> {copy.vc}</li>
                    <li>{number.format(plan.context)} {copy.context}</li>
                  </ul>
                </section>
              ))}
            </div>
          </section>

          <div className="divide-y divide-wd-border rounded-wd border border-wd-border bg-wd-card">
            {copy.sections.map((section) => (
              <section key={section.title} className="space-y-2.5 p-5 sm:px-7 sm:py-6">
                <h2 className="text-lg font-bold text-white">{section.title}</h2>
                <p className="max-w-3xl text-sm leading-relaxed text-wd-text md:text-base">{section.text}</p>
                <p className="max-w-3xl text-sm leading-relaxed text-wd-text-secondary">{section.detail}</p>
              </section>
            ))}
          </div>

          <aside className="flex flex-wrap items-center justify-between gap-3 border-t border-wd-border pt-5">
            <p className="text-sm font-semibold text-wd-text">{copy.supportTitle}</p>
            <Link href={withLocale("/support?topic=payment", locale)} className="inline-flex items-center gap-2 text-sm font-bold text-wd-secondary-text hover:underline">
              {copy.supportLink}<FaArrowRight aria-hidden className="text-xs" />
            </Link>
          </aside>
        </article>
      </main>
      <Footer />
    </div>
  );
}
