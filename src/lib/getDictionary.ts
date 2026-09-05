import ruCommon from "../../public/locales/ru/common.json";
import enCommon from "../../public/locales/en/common.json";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./i18nConfig";

const dictionaries = {
  ru: ruCommon,
  en: enCommon,
} as const;

type Dict = (typeof dictionaries)[Locale];

export function getDictionary(locale: string): Dict {
  return dictionaries[isLocale(locale) ? locale : DEFAULT_LOCALE];
}

function lookup(dict: unknown, key: string): string | undefined {
  const value = key.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, dict);
  return typeof value === "string" ? value : undefined;
}

export function translate(
  locale: string,
  key: string,
  vars?: Record<string, string | number>
): string {
  let value = lookup(getDictionary(locale), key) ?? key;
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replaceAll(`{{${name}}}`, String(replacement));
    }
  }
  return value;
}
