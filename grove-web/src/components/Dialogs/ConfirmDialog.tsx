import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "../ui";

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning" | "info";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Escape to close, Enter to confirm
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onCancel, onConfirm]);

  const variantStyles = {
    danger: {
      iconBg: "bg-[var(--color-error)]/10",
      iconColor: "text-[var(--color-error)]",
      buttonBg: "bg-[var(--color-error)] hover:bg-[var(--color-error)]/90",
    },
    warning: {
      iconBg: "bg-[var(--color-warning)]/10",
      iconColor: "text-[var(--color-warning)]",
      buttonBg: "bg-[var(--color-warning)] hover:bg-[var(--color-warning)]/90",
    },
    info: {
      iconBg: "bg-[var(--color-info)]/10",
      iconColor: "text-[var(--color-info)]",
      buttonBg: "bg-[var(--color-info)] hover:bg-[var(--color-info)]/90",
    },
  };

  const styles = variantStyles[variant];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onCancel}
            className="fixed inset-0 bg-black/50 z-50"
            data-hotkeys-dialog
          />

          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md"
          >
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${styles.iconBg}`}>
                    <AlertTriangle className={`w-5 h-5 ${styles.iconColor}`} />
                  </div>
                  <h2 className="text-lg font-semibold text-[var(--color-text)]">{title}</h2>
                </div>
                <button
                  onClick={onCancel}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <div className="px-5 py-4">
                {typeof message === "string" ? (
                  <p className="text-sm text-[var(--color-text-muted)] whitespace-pre-line">{message}</p>
                ) : (
                  <div className="text-sm text-[var(--color-text-muted)]">{message}</div>
                )}
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
                <Button variant="secondary" onClick={onCancel}>
                  {cancelLabel}
                </Button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={onConfirm}
                  className={`px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors ${styles.buttonBg}`}
                >
                  {confirmLabel}
                </motion.button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
