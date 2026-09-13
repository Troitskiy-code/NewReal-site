import Footer from "@/components/Footer";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { translate } from "@/lib/getDictionary";

export default async function CharacterNotFound() {
  const locale = await getRequestLocale();

  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-20 text-center">
        <h1 className="text-2xl font-black text-white">
          {translate(locale, "meta.character.fallbackTitle")}
        </h1>
        <p className="mt-2 max-w-md text-sm text-wd-text-secondary">
          {translate(locale, "meta.character.fallbackDescription")}
        </p>
      </main>
      <Footer />
    </div>
  );
}
