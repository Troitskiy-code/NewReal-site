import LandingFaq from "@/components/LandingFaq";
import LocaleLink from "@/components/LocaleLink";
import type { Locale } from "@/lib/i18nConfig";
import { homeAbout } from "@/lib/landingTexts";

/** Search copy under the first catalog page: what the service is, plus FAQ. */
export default function HomeAbout({ locale, freeQuota }: { locale: Locale; freeQuota: boolean }) {
  const text = homeAbout(locale, freeQuota);
  return (
    <section aria-labelledby="home-about" className="mt-6 max-w-3xl space-y-6 border-t border-wd-border pt-6">
      <div className="space-y-3">
        <h2 id="home-about" className="font-display text-lg font-semibold text-white md:text-xl">{text.heading}</h2>
        {text.paragraphs.map((paragraph, index) => (
          <p key={index} className="text-[15px] leading-relaxed text-wd-text/85">{paragraph}</p>
        ))}
        <div className="flex flex-wrap gap-2 pt-1">
          <LocaleLink href="/create" className="wd-button inline-flex px-5 py-2.5 text-xs">{text.createLink}</LocaleLink>
          <LocaleLink href="/genres" className="inline-flex items-center rounded-full border border-wd-border px-5 py-2.5 text-xs font-semibold text-white transition-colors hover:border-wd-secondary">
            {text.genresLink}
          </LocaleLink>
        </div>
      </div>
      <LandingFaq heading={text.faqHeading} items={text.faq} />
    </section>
  );
}
