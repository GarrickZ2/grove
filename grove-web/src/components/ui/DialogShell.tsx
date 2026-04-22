import { motion, AnimatePresence } from "framer-motion";
import { useIsMobile } from "../../hooks";

interface DialogShellProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Max width class for desktop mode, default "max-w-md" */
  maxWidth?: string;
  /**
   * Stacking level for this dialog. Raise when nesting one DialogShell inside
   * another (e.g. a confirmation on top of a list) so the inner backdrop
   * reliably sits above the outer backdrop and clicks hit the inner onClose.
   * Defaults to 50 (Tailwind `z-50`).
   */
  zIndex?: number;
}

/**
 * Shared dialog wrapper that renders as centered modal on desktop
 * and as a bottom sheet on mobile.
 */
export function DialogShell({
  isOpen,
  onClose,
  children,
  maxWidth = "max-w-md",
  zIndex = 50,
}: DialogShellProps) {
  const { isMobile } = useIsMobile();

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={(e) => {
              // Stop the event from bubbling to any wrapping dialog's
              // backdrop when this shell is nested inside another.
              e.stopPropagation();
              onClose();
            }}
            className="fixed inset-0 bg-black/50"
            style={{ zIndex }}
            data-hotkeys-dialog
          />

          {/* Dialog */}
          {isMobile ? (
            /* Mobile: Bottom Sheet */
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 30, stiffness: 300 }}
              className="fixed inset-x-0 bottom-0 w-full max-h-[85vh] overflow-y-auto"
              style={{ zIndex }}
            >
              <div className="bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)] rounded-t-2xl shadow-xl overflow-hidden">
                {/* Drag indicator */}
                <div className="flex justify-center pt-3 pb-1">
                  <div className="w-10 h-1 rounded-full bg-[var(--color-border)]" />
                </div>
                {children}
              </div>
            </motion.div>
          ) : (
            /* Desktop: Centered modal */
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ duration: 0.2 }}
              className={`fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full ${maxWidth}`}
              style={{ zIndex }}
            >
              {children}
            </motion.div>
          )}
        </>
      )}
    </AnimatePresence>
  );
}
