import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useIsMobile } from "../../hooks";

/** Track the visualViewport so a dialog can be positioned exactly inside it
 *  (above any virtual keyboard, below the iOS top bar, etc). Returns the
 *  fixed-position rectangle the visualViewport currently occupies in layout
 *  viewport coordinates. */
function useVisualViewportRect(enabled: boolean) {
  const [rect, setRect] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => setRect({ top: vv.offsetTop, height: vv.height });
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return rect;
}

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
  const vvRect = useVisualViewportRect(isMobile && isOpen);

  // No body-level scroll lock — that breaks touch-scroll inside the dialog
  // on iOS Safari. The dialog itself uses `overscroll-contain` to keep its
  // scroll from chaining to the page behind.

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
            /* Mobile: viewport-aligned wrapper that pins the bottom-sheet to
               the bottom of the visualViewport (i.e. just above any virtual
               keyboard). The wrapper itself is pointer-events:none so the
               backdrop receives clicks outside the sheet. */
            <div
              className="fixed inset-x-0 flex flex-col justify-end pointer-events-none"
              style={{
                zIndex,
                top: vvRect?.top ?? 0,
                height: vvRect ? `${vvRect.height}px` : "100%",
              }}
            >
              <motion.div
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 30, stiffness: 300 }}
                className="pointer-events-auto w-full max-h-full overflow-y-auto overscroll-contain"
                style={{ WebkitOverflowScrolling: "touch" }}
              >
                <div className="bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)] rounded-t-2xl shadow-xl overflow-hidden">
                  {/* Drag indicator */}
                  <div className="flex justify-center pt-3 pb-1">
                    <div className="w-10 h-1 rounded-full bg-[var(--color-border)]" />
                  </div>
                  {children}
                </div>
              </motion.div>
            </div>
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
