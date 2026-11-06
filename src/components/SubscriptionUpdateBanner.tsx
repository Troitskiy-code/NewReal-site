import Link from "next/link";
import { FaArrowRight, FaBullhorn } from "react-icons/fa";
import { withLocale, type Locale } from "@/lib/i18nConfig";
import { formatSubscriptionUpdateDate, SUBSCRIPTION_UPDATE_PATH, subscriptionUpdateCopy } from "@/lib/subscriptionUpdate";

export default function SubscriptionUpdateBanner({ locale, date, dateTime }: {
  locale: Locale;
  date: Date | null;
  dateTime: string | null;
}) {
  const copy = subscriptionUpdateCopy(locale);
  return (
    <aside lang={copy.lang} aria-label={copy.eyebrow} className="mx-4 mt-4 md:mx-6">
      <Link
        href={withLocale(SUBSCRIPTION_UPDATE_PATH, locale)}
        className="group flex flex-col items-start gap-3 rounded-wd border border-wd-secondary/35 bg-wd-card bg-[radial-gradient(ellipse_at_top_right,#39232b,transparent_75%)] p-4 transition-colors hover:border-wd-secondary sm:flex-row sm:items-center sm:gap-4 md:px-5"
      >
        <span className="hidden size-10 shrink-0 place-items-center rounded-full bg-wd-secondary/15 text-wd-secondary-text sm:grid">
          <FaBullhorn aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-wd-secondary-text">
            {date && dateTime ? <time dateTime={dateTime}>{formatSubscriptionUpdateDate(date, copy.lang)}</time> : copy.preview}
          </p>
          <p className="text-base font-extrabold text-white md:text-lg">{copy.bannerTitle}</p>
          <p className="mt-1 text-sm leading-relaxed text-wd-text-secondary">{copy.bannerText}</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-wd-secondary/45 px-3.5 py-2 text-xs font-bold text-wd-secondary-text transition-colors group-hover:bg-wd-secondary/10">
          {copy.bannerLink}<FaArrowRight aria-hidden className="text-[10px]" />
        </span>
      </Link>
    </aside>
  );
}
