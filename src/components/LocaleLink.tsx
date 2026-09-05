"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";
import {
  getLocaleFromPath,
  isLocale,
  stripLocalePrefix,
  withLocale,
  type Locale,
} from "@/lib/i18nConfig";

export function useCurrentLocale(): Locale {
  const pathname = usePathname();
  const { i18n } = useTranslation();
  return getLocaleFromPath(pathname) ?? (isLocale(i18n.language) ? i18n.language : "ru");
}

export function useLocalizedPathname(): string {
  const pathname = usePathname();
  return stripLocalePrefix(pathname);
}

type LocaleLinkProps = React.ComponentProps<typeof Link>;

export default function LocaleLink({ href, ...props }: LocaleLinkProps) {
  const locale = useCurrentLocale();
  const localizedHref =
    typeof href === "string" && href.startsWith("/") && !href.startsWith("//")
      ? withLocale(href, locale)
      : href;

  return <Link href={localizedHref} {...props} />;
}
