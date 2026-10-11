import { useEffect, useId, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { DialogShell } from "../../ui/DialogShell";
import { useDefineCommand, useKeyboardScope } from "../../../keyboard";

interface ChatComposerPanelProps {
  open: boolean;
  mobileSheet: boolean;
  title: string;
  className: string;
  onClose: () => void;
  onSheetClosed: () => void;
  children: ReactNode;
}

/** Share the existing panel body between desktop composer and phone sheet. */
export function ChatComposerPanel({ open, mobileSheet, title, className, onClose, onSheetClosed, children }: ChatComposerPanelProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const sheetOpen = open && mobileSheet;
  useKeyboardScope("chat.mobileDetails", sheetOpen);
  useDefineCommand({
    id: "chat.mobileDetails.close",
    name: "Close Session Details",
    category: "Chat",
    defaultBindings: [{ key: "Escape" }],
    scope: "chat.mobileDetails",
    passThroughTextInput: true,
    handler: onClose,
  }, [onClose]);
  useEffect(() => {
    if (!sheetOpen) return;
    sheetRef.current?.focus({ preventScroll: true });
    return onSheetClosed;
  }, [sheetOpen, onSheetClosed]);

  if (mobileSheet) {
    return (
      <DialogShell isOpen={open} onClose={onClose} zIndex={90} swipeToClose>
        <div ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="mobile-composer-sheet outline-none" onPointerDown={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 pb-2">
            <h2 id={titleId} className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close Session details" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mobile-composer-sheet-body overflow-y-auto overscroll-contain">{children}</div>
        </div>
      </DialogShell>
    );
  }

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div initial={{ opacity: 0, y: 10, height: 0 }} animate={{ opacity: 1, y: 0, height: "auto" }} exit={{ opacity: 0, y: 8, height: 0 }} transition={{ duration: 0.2, ease: "easeOut" }} className={className}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
