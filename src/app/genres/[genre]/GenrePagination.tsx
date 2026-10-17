"use client";

import { useRouter } from "next/navigation";
import CharacterPagination from "@/components/CharacterPagination";
import { useCurrentLocale } from "@/components/LocaleLink";
import { withLocale } from "@/lib/i18nConfig";

/** Crawlable ?page= links; clicks navigate client-side to the server-rendered page. */
export default function GenrePagination({ basePath, page, totalPages }: { basePath: string; page: number; totalPages: number }) {
  const router = useRouter();
  const locale = useCurrentLocale();
  const hrefForPage = (target: number) => `${withLocale(basePath, locale)}${target > 1 ? `?page=${target}` : ""}`;

  return (
    <CharacterPagination
      page={page}
      totalPages={totalPages}
      hrefForPage={hrefForPage}
      onPageChange={(target) => {
        router.push(hrefForPage(target));
        window.scrollTo({ top: 0 });
      }}
    />
  );
}
