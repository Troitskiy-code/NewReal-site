"use client";

import { useTranslation } from "react-i18next";
import ErrorState, { ERROR_PRIMARY_BUTTON, ERROR_SECONDARY_BUTTON } from "@/components/ErrorState";
import LocaleLink from "@/components/LocaleLink";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const { t } = useTranslation();

  return (
    <ErrorState
      code="500"
      title={t("errorPage.errorTitle")}
      text={t("errorPage.errorText")}
      // The digest matches server logs without exposing the error message.
      note={error.digest ? `${t("errorPage.errorCode")}: ${error.digest}` : undefined}
    >
      <button type="button" onClick={() => retry()} className={ERROR_PRIMARY_BUTTON}>
        {t("errorPage.retry")}
      </button>
      <LocaleLink href="/" className={ERROR_SECONDARY_BUTTON}>
        {t("errorPage.toCatalog")}
      </LocaleLink>
    </ErrorState>
  );
}
