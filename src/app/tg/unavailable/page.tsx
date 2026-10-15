import Link from "next/link";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { translate } from "@/lib/getDictionary";
import { withLocale } from "@/lib/i18nConfig";
import DailyBonusCard from "@/components/DailyBonusCard";
import { OpenOutsideButton } from "./OpenOutsideButton";

// Shown by the proxy in place of shop pages and payment documents in the Telegram context.
// No prices, no purchase buttons, no links to payment: only the balance and the daily bonus.

const BROWSER_DOCUMENTS = new Set(["terms", "privacy"]);

export async function generateMetadata() {
  const locale = await getRequestLocale();
  return { title: `${translate(locale, "telegram.balanceTitle")} — NewVerse`, robots: { index: false, follow: false } };
}

export default async function TelegramUnavailablePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const locale = await getRequestLocale();
  const params = await searchParams;
  const section = params.section === "document" ? "document" : "shop";
  const doc = typeof params.doc === "string" ? params.doc : "";
  const t = (key: string) => translate(locale, key);

  return (
    <main data-testid="telegram-neutral-page" className="mx-auto w-full max-w-xl space-y-6 px-4 py-8">
      {section === "shop" ? (
        <>
          <h1 className="text-2xl font-black text-white">{t("telegram.balanceTitle")}</h1>
          <p className="text-sm text-wd-text-secondary">{t("telegram.balanceText")}</p>
          <DailyBonusCard />
        </>
      ) : (
        <>
          <h1 className="text-2xl font-black text-white">
            {BROWSER_DOCUMENTS.has(doc) ? t(`footer.${doc}`) : t("telegram.unavailableTitle")}
          </h1>
          {BROWSER_DOCUMENTS.has(doc) ? (
            <>
              <p className="text-sm text-wd-text-secondary">{t("telegram.documentText")}</p>
              <OpenOutsideButton href={withLocale(`/${doc}`, locale)} label={t("telegram.openInBrowser")} />
            </>
          ) : (
            <p className="text-sm text-wd-text-secondary">{t("telegram.unavailableText")}</p>
          )}
        </>
      )}
      <Link href={withLocale("/", locale)} className="inline-flex text-sm font-bold text-wd-secondary-text hover:text-white">
        {t("telegram.toCatalog")}
      </Link>
    </main>
  );
}
