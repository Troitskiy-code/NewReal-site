"use client";

import { useTranslation } from "react-i18next";

type CharacterPaginationProps = {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  hrefForPage?: (page: number) => string;
};

function paginationItems(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }

  const marked = new Set([1, total, current, current - 1, current + 1]);
  const pages = [...marked].filter((value) => value >= 1 && value <= total).sort((a, b) => a - b);
  const items: Array<number | "ellipsis"> = [];

  for (const page of pages) {
    const previous = items[items.length - 1];
    if (typeof previous === "number" && page - previous > 1) {
      items.push("ellipsis");
    }
    items.push(page);
  }

  return items;
}

const buttonClass =
  "h-10 min-w-10 shrink-0 items-center justify-center rounded-wd-pill px-3 text-sm font-medium tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wd-secondary disabled:pointer-events-none";

const inactiveClass = "text-wd-text-secondary hover:bg-white/5 hover:text-white";

export default function CharacterPagination({
  page,
  totalPages,
  onPageChange,
  disabled = false,
  hrefForPage,
}: CharacterPaginationProps) {
  const { t } = useTranslation();

  if (totalPages <= 1) {
    return null;
  }

  const items = paginationItems(page, totalPages);

  return (
    <nav
      className="flex justify-center pb-6 pt-2"
      aria-label={t("home.pagination")}
    >
      <div className="inline-flex max-w-full flex-nowrap items-center gap-1 rounded-wd-pill border border-wd-border bg-wd-card p-1">
        <button
          type="button"
          className={`${buttonClass} inline-flex ${inactiveClass} text-xl disabled:opacity-30`}
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label={t("home.prevPage")}
        >
          <span aria-hidden>‹</span>
        </button>

        <span
          className="inline-flex h-10 items-center gap-2 whitespace-nowrap px-4 text-sm tabular-nums sm:hidden"
          aria-current="page"
          aria-label={t("home.page", { page, pages: totalPages })}
        >
          <span className="font-semibold text-white">{page}</span>
          <span className="text-wd-text-secondary" aria-hidden>/</span>
          <span className="text-wd-text-secondary">{totalPages}</span>
        </span>

        {items.map((item, index) =>
          item === "ellipsis" ? (
            <span key={`ellipsis-${index}`} className="hidden w-6 shrink-0 justify-center text-sm text-wd-text-secondary sm:inline-flex" aria-hidden>
              …
            </span>
          ) : (
            hrefForPage ? <a
              key={item}
              href={hrefForPage(item)}
              className={item === page
                ? `${buttonClass} hidden bg-wd-primary text-white sm:inline-flex`
                : `${buttonClass} hidden ${inactiveClass} sm:inline-flex`}
              aria-disabled={disabled || item === page}
              aria-current={item === page ? "page" : undefined}
              aria-label={t("home.page", { page: item, pages: totalPages })}
              onClick={(event) => { event.preventDefault(); if (!disabled && item !== page) onPageChange(item); }}
            >{item}</a> : <button
              key={item}
              type="button"
              className={
                item === page
                  ? `${buttonClass} hidden bg-wd-primary text-white sm:inline-flex`
                  : `${buttonClass} hidden ${inactiveClass} sm:inline-flex`
              }
              disabled={disabled || item === page}
              onClick={() => onPageChange(item)}
              aria-current={item === page ? "page" : undefined}
              aria-label={t("home.page", { page: item, pages: totalPages })}
            >
              {item}
            </button>
          )
        )}

        <button
          type="button"
          className={`${buttonClass} inline-flex ${inactiveClass} text-xl disabled:opacity-30`}
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label={t("home.nextPage")}
        >
          <span aria-hidden>›</span>
        </button>
      </div>
    </nav>
  );
}
