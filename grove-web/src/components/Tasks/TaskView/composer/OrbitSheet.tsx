import type { ReactNode } from "react";
import { DialogShell } from "../../../ui/DialogShell";
import { useEscapeScope } from "../../../../keyboard/useEscapeScope";
import "./orbit-composer.css";

/**
 * Phone: a composer tray, the setup menu or the usage details as a bottom
 * sheet (the Orbit dialog layer's sheet: handle, swipe down, scrim).
 */
export function OrbitComposerSheet({ open, onClose, onEscape, label, children, className = "" }: {
  open: boolean;
  onClose: () => void;
  /** Escape; defaults to `onClose` (e.g. step back to the first level first). */
  onEscape?: () => void;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  useEscapeScope(open, onEscape ?? onClose);
  return (
    <DialogShell isOpen={open} onClose={onClose} zIndex={90} swipeToClose>
      <div className={`oc-sheet ${className}`} role="dialog" aria-label={label} onPointerDown={(event) => event.stopPropagation()}>
        {children}
      </div>
    </DialogShell>
  );
}
