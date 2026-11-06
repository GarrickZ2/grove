import { motion } from "framer-motion";
import { AlertTriangle, Info, X } from "lucide-react";
import { Button } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { useCommand, useKeyboardScope } from "../../keyboard";
import { useOrbitInterface } from "../../orbit/ui/interfaceContext";
import { Button as OrbitButton } from "../../orbit/ui/Button";
import { DialogBody, DialogFoot, DialogHead, DialogPanel, HoldButton } from "../../orbit/ui/Dialog";

/** Confirm labels that destroy something; Orbit asks for a press-and-hold on these. */
const DESTRUCTIVE_LABEL = /^(delet|remov|uninstall|reset|clean|discard|eras|wipe|purg|drop|destroy|force)/i;

function holdLabel(label: string): string {
  return `Hold to ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  actionsDisabled?: boolean;
  compactActions?: boolean;
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
  secondaryActionLabel,
  onSecondaryAction,
  actionsDisabled = false,
  compactActions = false,
  variant = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Escape to cancel, Cmd/Ctrl+Enter to confirm (catalog: dialog.confirm).
  // Register the handlers in a child component that only mounts while
  // isOpen=true. Multiple ConfirmDialog wrappers (TaskOperationDialogs
  // renders ~6 at once, each with isOpen=false) would otherwise all
  // register the same handler and noisily overwrite each other on every
  // re-render — only the last-mounted one would actually be live.
  useKeyboardScope("dialog.confirm", isOpen);
  const orbit = useOrbitInterface();

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

  if (orbit) {
    const size = compactActions ? "sm" : "md";
    // In-progress labels ("Deleting…") arrive with actions disabled; they
    // keep the hold button so the footer doesn't jump.
    const hold = variant === "danger" && DESTRUCTIVE_LABEL.test(confirmLabel);
    const stringMessage = typeof message === "string";
    const cancel = (
      <OrbitButton variant="ghost" size={size} onClick={onCancel} disabled={actionsDisabled}>
        {cancelLabel}
      </OrbitButton>
    );
    // Two ways forward sit together, with Cancel set apart from both.
    const secondary = Boolean(secondaryActionLabel && onSecondaryAction);
    return (
      <DialogShell isOpen={isOpen} onClose={onCancel} maxWidth="max-w-[420px]">
        {isOpen && (
          <ConfirmDialogBindings onConfirm={onConfirm} onCancel={onCancel} />
        )}
        <DialogPanel>
          <DialogHead
            icon={variant === "info" ? Info : AlertTriangle}
            tone={variant}
            title={title}
            description={stringMessage ? <p className="oui-dlg-message">{message}</p> : undefined}
          />
          {!stringMessage && (
            <DialogBody>
              <div className="oui-dlg-message is-node">{message}</div>
            </DialogBody>
          )}
          <DialogFoot
            lead={secondary ? cancel : undefined}
          >
            {secondary ? (
              <OrbitButton variant="secondary" size={size} onClick={onSecondaryAction} disabled={actionsDisabled}>
                {secondaryActionLabel}
              </OrbitButton>
            ) : cancel}
            {hold ? (
              <HoldButton onConfirm={onConfirm} disabled={actionsDisabled} size={size}>
                {actionsDisabled ? confirmLabel : holdLabel(confirmLabel)}
              </HoldButton>
            ) : (
              <OrbitButton
                variant="primary"
                size={size}
                onClick={onConfirm}
                disabled={actionsDisabled}
                className={variant === "danger" ? "oui-btn-tone" : undefined}
                style={variant === "danger" ? ({ "--oui-tone": "var(--o-error)" } as React.CSSProperties) : undefined}
              >
                {confirmLabel}
              </OrbitButton>
            )}
          </DialogFoot>
        </DialogPanel>
      </DialogShell>
    );
  }

  return (
    <DialogShell isOpen={isOpen} onClose={onCancel}>
      {isOpen && (
        <ConfirmDialogBindings onConfirm={onConfirm} onCancel={onCancel} />
      )}
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
        <div className={`flex justify-end bg-[var(--color-bg)] border-t border-[var(--color-border)] ${compactActions ? "gap-2 px-5 py-3" : "gap-3 px-5 py-4"}`}>
          <Button variant="secondary" size={compactActions ? "sm" : "md"} onClick={onCancel} disabled={actionsDisabled} className="whitespace-nowrap">
            {cancelLabel}
          </Button>
          {secondaryActionLabel && onSecondaryAction && (
            <Button variant="secondary" size={compactActions ? "sm" : "md"} onClick={onSecondaryAction} disabled={actionsDisabled} className="whitespace-nowrap">
              {secondaryActionLabel}
            </Button>
          )}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onConfirm}
            disabled={actionsDisabled}
            className={`${compactActions ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm"} whitespace-nowrap rounded-lg font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles.buttonBg}`}
          >
            {confirmLabel}
          </motion.button>
        </div>
      </div>
    </DialogShell>
  );
}

// Wires the catalog handlers only while the dialog is actually open.
// If we declared these at the outer level, every ConfirmDialog wrapper
// (TaskOperationDialogs renders ~6 simultaneously, all isOpen=false)
// would register identical handlers and noisily overwrite each other —
// only the last-mounted dialog's binding would be live.
function ConfirmDialogBindings({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useCommand("dialog.confirm.cancel", onCancel, [onCancel]);
  useCommand("dialog.confirm.submit", onConfirm, [onConfirm]);
  return null;
}
