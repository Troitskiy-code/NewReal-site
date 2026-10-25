"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { twMerge } from "tailwind-merge";

type CharacterPaginationProps = {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  hrefForPage?: (page: number) => string;
};

const buttonClass =
  "inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-wd-pill px-1.5 text-sm font-medium tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wd-secondary disabled:pointer-events-none";
const inactiveClass = "text-wd-text-secondary hover:bg-white/5 hover:text-white";

export default function CharacterPagination(props: CharacterPaginationProps) {
  if (props.totalPages <= 1) return null;
  const page = Math.max(1, Math.min(props.page, props.totalPages));
  // External page/filter changes also reset the chooser and its draft input.
  return <PaginationControls key={`${page}-${props.totalPages}`} {...props} page={page} />;
}

function PaginationControls({ page, totalPages, onPageChange, disabled = false, hrefForPage }: CharacterPaginationProps) {
  const { t } = useTranslation();
  const id = useId();
  const containerRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rangeStart, setRangeStart] = useState(Math.floor((page - 1) / 10) * 10 + 1);
  const [draft, setDraft] = useState(String(page));
  const [invalid, setInvalid] = useState(false);
  const rangeEnd = Math.min(rangeStart + 9, totalPages);
  const firstVisible = Math.max(1, Math.min(page - 1, totalPages - 2));
  const visiblePages = Array.from({ length: Math.min(3, totalPages) }, (_, i) => firstVisible + i);
  const panelOpen = open && !disabled;

  useEffect(() => {
    if (!panelOpen) return;
    panelRef.current?.scrollIntoView({ block: "nearest" });
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [panelOpen]);

  function closePanel() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function navigate(target: number) {
    if (disabled || target < 1 || target > totalPages) return;
    closePanel();
    if (target !== page) onPageChange(target);
  }

  function pageControl(target: number, className = "", children: ReactNode = target, label?: string) {
    const props = {
      className: twMerge(buttonClass, target === page ? "bg-wd-primary text-white" : inactiveClass, className),
      "aria-current": target === page ? "page" as const : undefined,
      "aria-label": label ?? t("home.page", { page: target, pages: totalPages }),
    };
    return hrefForPage ? (
      <a key={target} {...props} href={hrefForPage(target)} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined}
        onClick={(event) => {
          if (disabled) { event.preventDefault(); return; }
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          navigate(target);
        }}
      >{children}</a>
    ) : (
      <button key={target} type="button" {...props} disabled={disabled} onClick={() => navigate(target)}>{children}</button>
    );
  }

  return (
    <nav ref={containerRef} className="flex flex-col items-center pb-6 pt-2" aria-label={t("home.pagination")}>
      <p className="mb-3 text-center text-xs tabular-nums text-wd-text-secondary" aria-live="polite">
        {t("home.page", { page, pages: totalPages })}
      </p>
      <div className="inline-flex max-w-full flex-nowrap items-center gap-px rounded-wd-pill border border-wd-border bg-wd-card p-1 sm:gap-1">
        <button type="button" className={`${buttonClass} ${inactiveClass} text-xl disabled:opacity-30`}
          disabled={disabled || page <= 1} onClick={() => navigate(page - 1)} aria-label={t("home.prevPage")}
        ><span aria-hidden>‹</span></button>
        {visiblePages.map((target) => pageControl(target))}
        {totalPages > 3 && (
          <button ref={triggerRef} type="button" className={`${buttonClass} ${inactiveClass} disabled:opacity-30`}
            disabled={disabled} aria-label={t("home.pageChooser.open")} aria-expanded={panelOpen} aria-controls={`${id}-panel`}
            onClick={() => {
              if (!open) {
                setRangeStart(Math.floor((page - 1) / 10) * 10 + 1);
                setDraft(String(page));
                setInvalid(false);
              }
              setOpen(!open);
            }}
          ><span aria-hidden>…</span></button>
        )}
        <button type="button" className={`${buttonClass} ${inactiveClass} text-xl disabled:opacity-30`}
          disabled={disabled || page >= totalPages} onClick={() => navigate(page + 1)} aria-label={t("home.nextPage")}
        ><span aria-hidden>›</span></button>
      </div>

      {panelOpen && (
        <div ref={panelRef} id={`${id}-panel`} role="region" aria-labelledby={`${id}-title`}
          className="mt-3 w-full max-w-sm rounded-wd border border-wd-border bg-wd-card p-3 text-sm"
        >
          <div className="flex items-center justify-between gap-2">
            <p id={`${id}-title`} className="font-medium text-white">{t("home.pageChooser.title")}</p>
            <button type="button" className={`${buttonClass} ${inactiveClass} text-xl`} onClick={closePanel} aria-label={t("home.pageChooser.close")}>
              <span aria-hidden>×</span>
            </button>
          </div>
          <div className="mb-2 mt-1 flex items-center justify-between gap-2">
            <button type="button" className={`${buttonClass} ${inactiveClass} text-xl disabled:opacity-30`}
              disabled={rangeStart <= 1} onClick={() => setRangeStart(Math.max(1, rangeStart - 10))} aria-label={t("home.pageChooser.prevRange")}
            ><span aria-hidden>‹</span></button>
            <span className="text-xs tabular-nums text-wd-text-secondary" aria-live="polite">
              {t("home.pageChooser.range", { start: rangeStart, end: rangeEnd, pages: totalPages })}
            </span>
            <button type="button" className={`${buttonClass} ${inactiveClass} text-xl disabled:opacity-30`}
              disabled={rangeEnd >= totalPages} onClick={() => setRangeStart(rangeStart + 10)} aria-label={t("home.pageChooser.nextRange")}
            ><span aria-hidden>›</span></button>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {Array.from({ length: rangeEnd - rangeStart + 1 }, (_, index) =>
              pageControl(rangeStart + index, "min-w-0 rounded-xl px-0")
            )}
          </div>
          <div className="my-2 flex items-center justify-between gap-2 border-b border-wd-border pb-2">
            {pageControl(1, "px-2 text-xs", t("home.pageChooser.first"), t("home.pageChooser.firstLabel"))}
            {pageControl(totalPages, "px-2 text-xs", t("home.pageChooser.last", { pages: totalPages }), t("home.pageChooser.lastLabel"))}
          </div>
          <form noValidate onSubmit={(event) => {
            event.preventDefault();
            const target = Number(draft);
            if (!Number.isInteger(target) || target < 1 || target > totalPages) {
              setInvalid(true);
              return;
            }
            navigate(target);
          }}>
            <label htmlFor={`${id}-input`} className="mb-2 mt-3 block text-xs text-wd-text-secondary">{t("home.pageChooser.inputLabel")}</label>
            <div className="flex items-center gap-2">
              <input id={`${id}-input`} type="number" inputMode="numeric" min={1} max={totalPages} step={1} required
                value={draft} onChange={(event) => { setDraft(event.target.value); setInvalid(false); }}
                aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined}
                className="h-11 w-20 min-w-0 rounded-xl border border-wd-border bg-wd-bg px-2 text-center text-base tabular-nums text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wd-secondary"
              />
              <span className="mr-auto whitespace-nowrap tabular-nums text-wd-text-secondary">/ {totalPages}</span>
              <button type="submit" className={twMerge(buttonClass, "rounded-xl bg-wd-primary px-3 text-white hover:bg-wd-primary-hover")}>{t("home.pageChooser.go")}</button>
            </div>
            {invalid && <p id={`${id}-error`} role="alert" className="mt-2 text-xs text-wd-primary-soft">{t("home.pageChooser.invalid", { pages: totalPages })}</p>}
          </form>
        </div>
      )}
    </nav>
  );
}
