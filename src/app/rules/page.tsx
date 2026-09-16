import Footer from "@/components/Footer";
import { getLocalizedPageMetadata } from "@/lib/seo";
import { getDictionary, translate } from "@/lib/getDictionary";
import { getRequestLocale } from "@/lib/getRequestLocale";

export async function generateMetadata() {
  return getLocalizedPageMetadata("rules");
}

function stringList(locale: string, key: string): string[] {
  const value = key.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, getDictionary(locale));
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export default async function RulesPage() {
  const locale = await getRequestLocale();
  const prohibited = stringList(locale, "rules.prohibitedItems");
  const consequences = stringList(locale, "rules.consequenceItems");

  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="mb-6 text-3xl font-black uppercase tracking-tight text-white">
          {translate(locale, "rules.title")}
        </h1>
        <p className="mb-8 text-sm leading-relaxed text-wd-text-secondary">
          {translate(locale, "rules.intro")}
        </p>

        <div className="space-y-8 text-sm leading-relaxed text-wd-text-secondary">
          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">{translate(locale, "rules.prohibitedTitle")}</h2>
            <ul className="list-disc space-y-2 pl-5">
              {prohibited.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">{translate(locale, "rules.consequencesTitle")}</h2>
            <ol className="list-decimal space-y-2 pl-5">
              {consequences.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">{translate(locale, "rules.appealTitle")}</h2>
            <p>
              {translate(locale, "rules.appeal")}{" "}
              <a href="mailto:support@newvers.ai" className="text-wd-secondary underline hover:text-white">
                support@newvers.ai
              </a>
            </p>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}
