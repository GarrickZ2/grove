import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { X } from "lucide-react";
import { useEscapeScope } from "../../keyboard/useEscapeScope";
import { DialogLayerContext } from "../../components/ui/dialogLayerContext";
import { Button } from "./Button";
import { hasMacWindowControls } from "./windowControls";

const SHEET_SPRING = { type: "spring", stiffness: 380, damping: 36, mass: 0.9 } as const;

interface SheetProps {
  open: boolean;
  /** Scrim, Close button. */
  onClose: () => void;
  /** Escape; defaults to `onClose` (e.g. step back out of a detail first). */
  onEscape?: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Right of the title, before Close (e.g. a Saved chip). */
  aside?: ReactNode;
  /** Leading slot before the title (e.g. a Back button). */
  lead?: ReactNode;
  /** Wide sheets hold a transcript; the width eases between sizes (CSS). */
  wide?: boolean;
  label: string;
  children: ReactNode;
}

/** Right-edge sheet over a blurred scrim. Portaled so it covers the whole window. */
export function Sheet({ open, onClose, onEscape, ...layer }: SheetProps) {
  useEscapeScope(open, onEscape ?? onClose);
  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open ? <SheetLayer key="sheet" onClose={onClose} {...layer} /> : null}
    </AnimatePresence>,
    document.body,
  );
}

function SheetLayer({ onClose, title, description, aside, lead, wide = false, label, children }: Omit<SheetProps, "open" | "onEscape">) {
  // While it animates out the layer still covers the window; it stops taking
  // pointer events at once so a click right after closing reaches the page.
  const present = useIsPresent();
  return (
    <div className={`orbit-ui oui-sheet-root${hasMacWindowControls ? " has-mac-controls" : ""}${present ? "" : " is-leaving"}`}>
      <motion.button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="oui-sheet-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      />
      <motion.aside
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`oui-sheet${wide ? " is-wide" : ""}`}
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={SHEET_SPRING}
      >
        <div className="oui-sheet-head">
          {lead}
          <div className="oui-sheet-head-copy">
            <h2>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          {aside}
          <Button variant="ghost" iconOnly aria-label="Close" title="Close" onClick={onClose}><X /></Button>
        </div>
        {/* Confirm dialogs opened from inside stack above the sheet. */}
        <DialogLayerContext.Provider value={100}>{children}</DialogLayerContext.Provider>
      </motion.aside>
    </div>
  );
}
