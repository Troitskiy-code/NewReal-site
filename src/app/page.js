import { Suspense } from "react";
import JsonLd from "@/components/JsonLd";
import { getRequestLocale } from "@/lib/getRequestLocale";
import { buildWebsiteJsonLd } from "@/lib/jsonLd";
import HomePageContent from "./HomePageContent";

export default async function HomePage() {
  const locale = await getRequestLocale();

  return (
    <>
      <JsonLd data={buildWebsiteJsonLd(locale)} />
      <Suspense
        fallback={
          <div className="flex min-h-dvh items-center justify-center bg-[#121212]">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-wd-primary border-t-transparent" />
          </div>
        }
      >
        <HomePageContent />
      </Suspense>
    </>
  );
}
