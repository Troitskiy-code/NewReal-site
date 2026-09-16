"use client";

import { Trans, useTranslation } from "react-i18next";
import LocaleLink from "@/components/LocaleLink";

type ModerationWarningProps = {
  reason?: string | null;
  className?: string;
};

export default function ModerationWarning({ reason, className = "" }: ModerationWarningProps) {
  const { t } = useTranslation();
  const displayReason = reason?.trim() || t("moderation.unknownReason");

  return (
    <div
      className={`rounded-wd border border-orange-500/45 bg-orange-500/10 p-4 text-sm leading-relaxed text-orange-100 ${className}`}
      role="alert"
    >
      <p className="font-bold text-orange-200">{t("moderation.warningTitle")}</p>
      <p className="mt-2">
        <Trans
          i18nKey="moderation.warningBody"
          values={{ reason: displayReason }}
          components={{
            rules: (
              <LocaleLink href="/rules" className="font-semibold underline hover:text-white" />
            ),
          }}
        />
      </p>
    </div>
  );
}
