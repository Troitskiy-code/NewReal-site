import type { Metadata } from "next";
import { translate } from "@/lib/getDictionary";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { DEFAULT_LOCALE } from "@/lib/i18nConfig";

export const SITE_URL = "https://newvers.ai";
export const OG_IMAGE = "/logo.png";

export type MetaPageKey =
  | "home"
  | "gallery"
  | "create"
  | "edit"
  | "profile"
  | "pricing"
  | "coins"
  | "referral"
  | "subscription"
  | "offer"
  | "refund"
  | "terms"
  | "support"
  | "forgotPassword"
  | "resetPassword"
  | "login"
  | "register";

export function createPageMetadata(title: string, description: string): Metadata {
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: OG_IMAGE }],
    },
  };
}

function pageMetadata(page: MetaPageKey, locale = DEFAULT_LOCALE): Metadata {
  return createPageMetadata(
    translate(locale, `meta.${page}.title`),
    translate(locale, `meta.${page}.description`)
  );
}

export const PAGE_METADATA = {
  home: pageMetadata("home"),
  gallery: pageMetadata("gallery"),
  create: pageMetadata("create"),
  edit: pageMetadata("edit"),
  profile: pageMetadata("profile"),
  pricing: pageMetadata("pricing"),
  coins: pageMetadata("coins"),
  referral: pageMetadata("referral"),
  subscription: pageMetadata("subscription"),
  offer: pageMetadata("offer"),
  refund: pageMetadata("refund"),
  terms: pageMetadata("terms"),
  support: pageMetadata("support"),
  forgotPassword: pageMetadata("forgotPassword"),
  resetPassword: pageMetadata("resetPassword"),
} as const;

export function chatPageMetadata(characterName: string, locale = DEFAULT_LOCALE): Metadata {
  return createPageMetadata(
    translate(locale, "meta.chat.title", { name: characterName }),
    translate(locale, "meta.chat.description", { name: characterName })
  );
}

export async function getLocalizedPageMetadata(page: MetaPageKey): Promise<Metadata> {
  const locale = await getRequestLocale();
  return createPageMetadata(
    translate(locale, `meta.${page}.title`),
    translate(locale, `meta.${page}.description`)
  );
}
