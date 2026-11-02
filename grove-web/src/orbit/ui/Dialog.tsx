import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type HTMLAttributes, type ReactNode } from "react";
import { AnimatePresence, MotionConfig, motion, useIsPresent } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import "../tokens.css";
import "./orbit-ui.css";
import "./overlays.css";
import { hasMacWindowControls } from "./windowControls";

/* Orbit dialog: a frosted, centered panel over a blurred scrim (a bottom sheet
   on phones). The layer only positions and animates; the panel parts below
   paint the surface, so dialogs that bring their own card still fit. */

const DIALOG_SPRING = { type: "spring", stiffness: 460, damping: 34, mass: 0.8 } as const;
const SHEET_SPRING = { type: "spring", stiffness: 380, damping: 36, mass: 0.9 } as const;
const EXIT = { duration: 0.14, ease: [0.25, 1, 0.5, 1] } as const;

export interface OrbitDialogLayerProps {
  open: boolean;
  /** Scrim click. */
  onClose: () => void;
  children: ReactNode;
  /** Stacking level of the whole layer. */
  zIndex?: number;
  /** Width class for the centered frame (e.g. "max-w-md"). */
  maxWidth?: string;
  /** Bottom sheet instead of a centered frame (phones). */
  sheet?: boolean;
  /** The visualViewport rectangle the sheet is pinned inside. */
  sheetRect?: { top: number; height: number } | null;
  /** Handlers for the sheet's drag handle (swipe to dismiss). */
  handleProps?: HTMLAttributes<HTMLDivElement>;
  /** The handle is a swipe target, not just an indicator. */
  swipeable?: boolean;
  label?: string;
  /** Destructive confirmations announce as alert dialogs. */
  alert?: boolean;
}

export function OrbitDialogLayer({ open, ...layer }: OrbitDialogLayerProps) {
  return <AnimatePresence>{open ? <Layer key="orbit-dialog" {...layer} /> : null}</AnimatePresence>;
}

function Layer({
  onClose, children, zIndex = 50, maxWidth = "max-w-md", sheet = false, sheetRect = null,
  handleProps, swipeable = false, label, alert = false,
}: Omit<OrbitDialogLayerProps, "open">) {
  // While animating out the layer still covers the window; it stops taking
  // pointer events at once so a click right after closing reaches the page.
  const present = useIsPresent();
  const rootStyle: CSSProperties = sheet && sheetRect
    ? { zIndex, top: sheetRect.top, height: `${sheetRect.height}px`, bottom: "auto" }
    : { zIndex };
  const role = alert ? "alertdialog" : "dialog";
  return (
    <MotionConfig reducedMotion="user">
      <div className={`orbit-ui oui-dlg-root${sheet ? " is-sheet" : ""}${hasMacWindowControls ? " has-mac-controls" : ""}${present ? "" : " is-leaving"}`} style={rootStyle}>
        <motion.div
          className="oui-dlg-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: EXIT }}
          transition={{ duration: 0.2 }}
          onClick={(event) => {
            // A nested dialog's scrim must not also close the one under it.
            event.stopPropagation();
            onClose();
          }}
          data-hotkeys-dialog
        />
        {sheet ? (
          <motion.div
            role={role}
            aria-modal="true"
            aria-label={label}
            className="oui-dlg-sheet"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={SHEET_SPRING}
          >
            <div className={`oui-dlg-grip${swipeable ? " is-swipe" : ""}`} {...handleProps}><span /></div>
            {children}
          </motion.div>
        ) : (
          <motion.div
            role={role}
            aria-modal="true"
            aria-label={label}
            className={`oui-dlg-frame w-full ${maxWidth}`}
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98, transition: EXIT }}
            transition={DIALOG_SPRING}
          >
            {children}
          </motion.div>
        )}
      </div>
    </MotionConfig>
  );
}

interface DialogPanelProps {
  children: ReactNode;
  /** Renders a form; Enter in a field submits it. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  size?: "sm" | "md";
  className?: string;
}

/** The frosted surface. */
export function DialogPanel({ children, onSubmit, size = "md", className }: DialogPanelProps) {
  const classes = `oui-dlg${size === "sm" ? " is-sm" : ""}${className ? ` ${className}` : ""}`;
  if (onSubmit) return <form className={classes} onSubmit={onSubmit}>{children}</form>;
  return <div className={classes}>{children}</div>;
}

export type DialogTone = "danger" | "warning" | "info";

interface DialogHeadProps {
  title: ReactNode;
  description?: ReactNode;
  /** Tone tile above the title (destructive and warning confirmations). */
  icon?: LucideIcon;
  tone?: DialogTone;
  /** Right of the title (e.g. a status chip). */
  aside?: ReactNode;
}

export function DialogHead({ title, description, icon: Icon, tone = "info", aside }: DialogHeadProps) {
  return (
    <div className="oui-dlg-head">
      {Icon ? <span className={`oui-dlg-ic is-${tone}`}><Icon aria-hidden="true" /></span> : null}
      <div className="oui-dlg-title">
        <h2>{title}</h2>
        {aside}
      </div>
      {description ? <div className="oui-dlg-desc">{description}</div> : null}
    </div>
  );
}

export function DialogBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`oui-dlg-body${className ? ` ${className}` : ""}`}>{children}</div>;
}

interface DialogFootProps {
  children: ReactNode;
  /** Muted note at the leading edge (e.g. a shortcut hint). */
  hint?: ReactNode;
  /** Leading action (e.g. "Archive instead"). */
  lead?: ReactNode;
}

export function DialogFoot({ children, hint, lead }: DialogFootProps) {
  return (
    <div className="oui-dlg-foot">
      {lead}
      {hint ? <span className="oui-dlg-hint">{hint}</span> : null}
      <span className="oui-dlg-sp" />
      {children}
    </div>
  );
}

interface DialogFieldProps {
  label: ReactNode;
  children: ReactNode;
  /** Right of the label (e.g. a spinner or a status note). */
  aside?: ReactNode;
  /** Below the control. */
  note?: ReactNode;
  /** `div` when the control is a button (a label would forward clicks). */
  as?: "label" | "div";
}

export function DialogField({ label, children, aside, note, as = "label" }: DialogFieldProps) {
  const Tag = as;
  return (
    <Tag className="oui-dlg-field">
      <span className="oui-dlg-label">{label}{aside ? <span className="oui-dlg-label-aside">{aside}</span> : null}</span>
      {children}
      {note ? <span className="oui-dlg-note">{note}</span> : null}
    </Tag>
  );
}

interface HoldButtonProps {
  /** Fires after a full press-and-hold, or at once from the keyboard. */
  onConfirm: () => void;
  /** Idle label, e.g. "Hold to delete". */
  children: ReactNode;
  holdingLabel?: string;
  disabled?: boolean;
  size?: "md" | "sm";
  /** Hold duration in ms. */
  duration?: number;
}

/**
 * Destructive confirm that needs a press-and-hold with a pointer, so a stray
 * click can't fire it. Keyboard activation (Enter / Space) confirms at once.
 */
export function HoldButton({ onConfirm, children, holdingLabel = "Keep holding…", disabled = false, size = "md", duration = 900 }: HoldButtonProps) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const release = () => {
    window.clearTimeout(timer.current);
    setHolding(false);
  };
  return (
    <button
      type="button"
      disabled={disabled}
      title="Press and hold to confirm"
      className={`oui-btn oui-btn-hold${size === "sm" ? " oui-btn-sm" : ""}${holding ? " is-holding" : ""}`}
      style={{ "--oui-hold": `${duration}ms` } as CSSProperties}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        window.clearTimeout(timer.current);
        setHolding(true);
        timer.current = window.setTimeout(() => {
          setHolding(false);
          onConfirm();
        }, duration);
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => {
        // Pointer clicks only count through the hold; keyboard clicks have no detail.
        if (event.detail === 0) onConfirm();
      }}
    >
      <span className="oui-hold-fill" aria-hidden="true" />
      <span className="oui-hold-label">{holding ? holdingLabel : children}</span>
    </button>
  );
}
