import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import Backend from "i18next-http-backend";
import { localeResources } from "./localeResources.generated";
import { DEFAULT_LOCALE, LOCALES, localeFallbacks } from "./i18nConfig";

const isBrowser = typeof window !== "undefined";

if (!i18n.isInitialized) {
  if (isBrowser) {
    i18n.use(Backend);
  }

  i18n.use(initReactI18next).init({
    fallbackLng: (locale) => localeFallbacks(locale).slice(1),
    lng: DEFAULT_LOCALE,
    supportedLngs: LOCALES,
    backend: {
      loadPath: "/locales/{{lng}}/{{ns}}.json",
    },
    resources: localeResources,
    ns: ["common"],
    defaultNS: "common",
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });
}

export default i18n;
