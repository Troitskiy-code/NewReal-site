import { isCharacterSort } from "@/lib/characterSort";
import type { SeoSearchParams } from "@/lib/seoIndexing";

type PageText = { title: string; description: string };
type Translate = (key: string, vars?: Record<string, string | number>) => string;

const first = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw) ?? "";

/**
 * Catalog variants (?sort, ?page, ?q) stay noindex, but each still gets its own title and
 * description: crawlers that saw them before the noindex must not count them as copies of home.
 * The translator is passed in, so the rule can be checked without the Next.js dictionary loader.
 */
export function catalogVariantText(t: Translate, searchParams: SeoSearchParams, home: PageText): PageText {
  const query = first(searchParams.q).trim().replace(/\s+/g, " ").replace(/[«»"“”]/g, "").slice(0, 60);
  const sortValue = first(searchParams.sort);
  const sort = isCharacterSort(sortValue) && sortValue !== "top" ? sortValue : null;
  const page = Math.max(1, Number.parseInt(first(searchParams.page), 10) || 1);
  if (!query && !sort && page === 1) return home;

  const name = query
    ? t("meta.catalog.search", { query })
    : sort ? t(`meta.catalog.sort.${sort}`) : t("meta.catalog.all");
  const description = query
    ? t("meta.catalog.searchDescription", { query })
    : sort ? t(`meta.catalog.sortDescription.${sort}`) : t("meta.catalog.description");
  return {
    title: t("meta.catalog.title", { name: page > 1 ? `${name}${t("meta.catalog.pageSuffix", { page })}` : name }),
    description: page > 1 ? `${description} ${t("meta.catalog.pageSentence", { page })}` : description,
  };
}
