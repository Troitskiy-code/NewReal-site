import type { Metadata } from "next";
import { translate } from "@/lib/getDictionary";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { DEFAULT_LOCALE } from "@/lib/i18nConfig";

export const SITE_URL = "https://newvers.ai";
export const OG_IMAGE = "/logo.png";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_ALT = "NewVerse — ролевые игры с ИИ-персонажами";
export const THEME_COLOR = "#0A0A0A";

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
  | "notifications"
  | "offer"
  | "refund"
  | "terms"
  | "privacy"
  | "support"
  | "forgotPassword"
  | "resetPassword"
  | "login"
  | "register"
  | "verifyEmail";

export function createPageMetadata(title: string, description: string, image: string = OG_IMAGE): Metadata {
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [
        {
          url: image,
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
          alt: OG_IMAGE_ALT,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
    icons: {
      icon: [
        { url: "/favicon-48x48.png", type: "image/png", sizes: "48x48" },
        { url: "/favicon-96x96.png", type: "image/png", sizes: "96x96" },
        { url: "/favicon.ico", sizes: "any" },
        { url: "/icon-192x192.png", type: "image/png", sizes: "192x192" },
        { url: "/icon-512x512.png", type: "image/png", sizes: "512x512" },
      ],
      apple: "/apple-touch-icon.png",
    },
    manifest: "/manifest.json",
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
