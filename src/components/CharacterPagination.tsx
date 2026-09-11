"use client";

import { useTranslation } from "react-i18next";

type CharacterPaginationProps = {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
};

function paginationItems(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }

  const marked = new Set([1, total, current, current - 1, current + 1, current - 2, current + 2]);
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
  "inline-flex h-10 min-w-10 items-center justify-center rounded-wd-pill border px-3 text-xs font-bold transition-colors disabled:opacity-50";

export default function CharacterPagination({
  page,
  totalPages,
  onPageChange,
  disabled = false,
}: CharacterPaginationProps) {
  const { t } = useTranslation();

  if (totalPages <= 1) {
    return null;
  }

  const items = paginationItems(page, totalPages);

  return (
    <nav
      className="flex flex-wrap items-center justify-center gap-2 pb-6 pt-2"
      aria-label={t("home.pagination")}
    >
      <button
        type="button"
        className={`${buttonClass} border-wd-border bg-wd-card text-white hover:border-wd-secondary`}
        disabled={disabled || page <= 1}
        onClick={() => onPageChange(page - 1)}
        aria-label={t("home.prevPage")}
      >
        ‹
      </button>

      {items.map((item, index) =>
        item === "ellipsis" ? (
          <span key={`ellipsis-${index}`} className="px-1 text-sm text-wd-text-secondary" aria-hidden>
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            className={
              item === page
                ? `${buttonClass} border-wd-primary bg-wd-primary text-white`
                : `${buttonClass} border-wd-border bg-wd-card text-white hover:border-wd-secondary`
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
        className={`${buttonClass} border-wd-border bg-wd-card text-white hover:border-wd-secondary`}
        disabled={disabled || page >= totalPages}
        onClick={() => onPageChange(page + 1)}
        aria-label={t("home.nextPage")}
      >
        ›
      </button>
    </nav>
  );
}
