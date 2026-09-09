"use client";

type ConfirmModalProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export default function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = "Подтвердить",
  cancelLabel = "Отмена",
  danger = false,
  loading = false,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/70 px-4"
      onClick={loading ? undefined : onClose}
      role="presentation"
    >
      <div
        className="wd-card w-full max-w-md space-y-4 p-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
      >
        <h2 id="confirm-modal-title" className="text-lg font-black text-white">
          {title}
        </h2>
        <p className="text-sm leading-relaxed text-wd-text-secondary">{description}</p>
        <div className="flex flex-col gap-3 sm:flex-row-reverse">
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`inline-flex flex-1 items-center justify-center gap-2 rounded-wd-pill px-4 py-3 text-sm font-bold disabled:opacity-50 ${
              danger
                ? "border border-wd-primary/40 bg-wd-primary/15 text-wd-primary hover:bg-wd-primary/25"
                : "wd-button"
            }`}
          >
            {loading && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            )}
            {confirmLabel}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 py-3 text-sm font-medium text-wd-text-secondary hover:text-white disabled:opacity-50"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
