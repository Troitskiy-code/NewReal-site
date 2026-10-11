import Link from "next/link";
import ErrorState, { ERROR_PRIMARY_BUTTON } from "@/components/ErrorState";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { translate } from "@/lib/getDictionary";
import { withLocale } from "@/lib/i18nConfig";

export async function generateMetadata() {
  const locale = await getRequestLocale();
  return { title: `${translate(locale, "errorPage.notFoundTitle")} — NewVerse` };
}

export default async function NotFound() {
  const locale = await getRequestLocale();

  return (
    <ErrorState
      code="404"
      title={translate(locale, "errorPage.notFoundTitle")}
      text={translate(locale, "errorPage.notFoundText")}
    >
      <Link href={withLocale("/", locale)} className={ERROR_PRIMARY_BUTTON}>
        {translate(locale, "errorPage.toCatalog")}
      </Link>
    </ErrorState>
  );
}
