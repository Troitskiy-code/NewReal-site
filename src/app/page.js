import JsonLd from "@/components/JsonLd";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { buildWebsiteJsonLd } from "@/lib/jsonLd";
import HomePageContent from "./HomePageContent";
import HomeAbout from "@/components/HomeAbout";
import { getLocalizedPageMetadata } from "@/lib/seo";
import { getPublicCatalog, parseCatalogQuery } from "@/lib/publicCatalog";
import { getViewerId } from "@/lib/characterPublic";
import { isFreeDailyQuotaEnabled } from "@/lib/freeDailyQuotaServer";
import { isOnboardingEnabled, readOnboardingPrefs, shouldShowOnboarding } from "@/lib/onboardingServer";

export async function generateMetadata({ searchParams }) {
  return getLocalizedPageMetadata("home", { searchParams: await searchParams });
}

export default async function HomePage({ searchParams }) {
  const locale = await getRequestLocale();
  const query = parseCatalogQuery(await searchParams);
  const [initialData, viewerId, onboardingPrefs] = await Promise.all([
    getPublicCatalog(query.sort, query.page, query.search),
    getViewerId(),
    readOnboardingPrefs(),
  ]);
  const showHero = !viewerId && query.page === 1 && !query.search;
  const freeQuota = isFreeDailyQuotaEnabled();
  const onboarding = {
    enabled: isOnboardingEnabled(),
    show: query.page === 1 && !query.search && await shouldShowOnboarding(viewerId, onboardingPrefs),
    prefs: onboardingPrefs,
  };

  return (
    <>
      <JsonLd data={buildWebsiteJsonLd(locale)} />
      <HomePageContent
        key={`${query.sort}:${query.page}:${query.search}`}
        initialData={initialData}
        showHero={showHero}
        onboarding={onboarding}
        freeQuotaOffer={freeQuota}
        about={query.page === 1 && !query.search ? <HomeAbout locale={locale} freeQuota={freeQuota} /> : null}
      />
    </>
  );
}
