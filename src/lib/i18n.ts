import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import Backend from "i18next-http-backend";
import ru from "../../public/locales/ru/common.json";
import en from "../../public/locales/en/common.json";
import { DEFAULT_LOCALE } from "./i18nConfig";

const isBrowser = typeof window !== "undefined";

if (!i18n.isInitialized) {
  if (isBrowser) {
    i18n.use(Backend);
  }

  i18n.use(initReactI18next).init({
    fallbackLng: DEFAULT_LOCALE,
    lng: DEFAULT_LOCALE,
    supportedLngs: ["ru", "en"],
    backend: {
      loadPath: "/locales/{{lng}}/{{ns}}.json",
    },
    resources: {
      ru: { common: ru },
      en: { common: en },
    },
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
