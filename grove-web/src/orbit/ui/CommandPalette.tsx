import type { ButtonHTMLAttributes, CSSProperties, KeyboardEvent, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, MotionConfig, motion, useIsPresent } from "framer-motion";
import { Search } from "lucide-react";
import "../tokens.css";
import "./orbit-ui.css";
import "./overlays.css";

/* Orbit command palette (Raycast style): a frosted panel high on the screen
   with a large borderless query field, grouped rows with a sliding accent
   bar on the active one, and a keycap footer. Presentation only: callers own
   the query, ranking, highlight and keyboard handling. */

const PALETTE_SPRING = { type: "spring", stiffness: 520, damping: 36, mass: 0.7 } as const;
const EXIT = { duration: 0.12, ease: [0.25, 1, 0.5, 1] } as const;

export interface PaletteHint {
  keys: string[];
  label: string;
}

interface OrbitCommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the palette. */
  label: string;
  query: string;
  onQueryChange: (value: string) => void;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Keys typed in the query field. */
  onInputKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** Keys anywhere in the panel. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Chip at the end of the query field (what is being searched). */
  scope?: ReactNode;
  listRef?: Ref<HTMLDivElement>;
  /** Rows, groups or an empty state. */
  children: ReactNode;
  hints?: PaletteHint[];
  /** Trailing edge of the footer (e.g. a result count). */
  footerAside?: ReactNode;
  zIndex?: number;
}

export function OrbitCommandPalette({ open, ...palette }: OrbitCommandPaletteProps) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>{open ? <PaletteLayer key="orbit-palette" {...palette} /> : null}</AnimatePresence>,
    document.body,
  );
}

function PaletteLayer({
  onClose, label, query, onQueryChange, placeholder, inputRef, onInputKeyDown, onKeyDown,
  scope, listRef, children, hints = [], footerAside, zIndex = 50,
}: Omit<OrbitCommandPaletteProps, "open">) {
  const present = useIsPresent();
  return (
    <MotionConfig reducedMotion="user">
      <div className={`orbit-ui oui-pal-root${present ? "" : " is-leaving"}`} style={{ zIndex }}>
        <motion.div
          className="oui-pal-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: EXIT }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
          data-hotkeys-dialog
        />
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          className="oui-pal"
          initial={{ opacity: 0, y: -10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.985, transition: EXIT }}
          transition={PALETTE_SPRING}
          onKeyDown={onKeyDown}
        >
          <div className="oui-pal-in">
            <Search aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              aria-label={placeholder}
              placeholder={placeholder}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => onQueryChange(event.target.value)}
              onKeyDown={onInputKeyDown}
            />
            {scope ? <span className="oui-pal-scope">{scope}</span> : null}
          </div>
          <div ref={listRef} className="oui-pal-list oui-scroll" role="listbox" aria-label={label}>
            {children}
          </div>
          {hints.length > 0 || footerAside ? (
            <div className="oui-pal-foot">
              {hints.map((hint) => (
                <span key={hint.label}>
                  <span className="oui-keys">{hint.keys.map((key) => <kbd key={key} className="oui-kbd">{key}</kbd>)}</span>
                  {hint.label}
                </span>
              ))}
              <span className="oui-pal-sp" />
              {footerAside ? <span className="oui-tnum">{footerAside}</span> : null}
            </div>
          ) : null}
        </motion.div>
      </div>
    </MotionConfig>
  );
}

export function PaletteGroup({ children }: { children: ReactNode }) {
  return <div className="oui-pal-group" role="presentation">{children}</div>;
}

export function PaletteEmpty({ children }: { children: ReactNode }) {
  return <div className="oui-pal-empty">{children}</div>;
}

interface PaletteItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  active: boolean;
  /** Leading tile content (an icon); `iconStyle` tints the tile. */
  icon?: ReactNode;
  iconStyle?: CSSProperties;
  title: ReactNode;
  /** Muted text inline after the title. */
  meta?: ReactNode;
  /** Second line. */
  description?: ReactNode;
  /** Right edge (keycaps, a "current" note). */
  trailing?: ReactNode;
}

/** One result row. Not tabbable: focus stays in the query field. */
export function PaletteItem({ active, icon, iconStyle, title, meta, description, trailing, className, ...button }: PaletteItemProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className={`oui-pal-item${active ? " is-active" : ""}${description ? " is-tall" : ""}${className ? ` ${className}` : ""}`}
      {...button}
    >
      {icon ? <span className="oui-pal-ic" style={iconStyle}>{icon}</span> : null}
      <span className="oui-pal-copy">
        <span className="oui-pal-name">
          <span className="oui-truncate">{title}</span>
          {meta ? <em>{meta}</em> : null}
        </span>
        {description ? <span className="oui-pal-desc oui-truncate">{description}</span> : null}
      </span>
      {trailing ? <span className="oui-pal-trail">{trailing}</span> : null}
    </button>
  );
}

/** Keycaps for a display string ("⌘K", "Cmd+Shift+P" already formatted). */
export function PaletteKeys({ keys }: { keys: string[] }) {
  return <span className="oui-keys">{keys.map((key, index) => <kbd key={index} className="oui-kbd">{key}</kbd>)}</span>;
}
