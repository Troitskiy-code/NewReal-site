import { localeResources } from "./localeResources.generated";
import { localeFallbacks, resolveLocale } from "./i18nConfig";

const cache = new Map<string, Record<string, unknown>>();
function merge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge((result[key] && typeof result[key] === "object" ? result[key] : {}) as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return result;
}
export function getDictionary(locale: string): Record<string, unknown> {
  const code = resolveLocale(locale);
  if (!cache.has(code)) cache.set(code, [...localeFallbacks(code)].reverse().reduce((dict, fallback) => merge(dict, localeResources[fallback].common), {}));
  return cache.get(code)!;
}

/** For structured page copy (lists, FAQs); strings use translate() for interpolation. */
export function localizedValue<T>(locale: string, key: string): T {
  return key.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined, getDictionary(locale)) as T;
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
  let value = localeFallbacks(locale).map((code) => lookup(getDictionary(code), key)).find((text) => text !== undefined) ?? key;
  if (vars) {
    for (const [name, replacement] of Object.entries(vars)) {
      value = value.replaceAll(`{{${name}}}`, () => String(replacement));
    }
  }
  return value;
}
