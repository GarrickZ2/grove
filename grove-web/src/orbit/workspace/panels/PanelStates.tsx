import type { ReactNode } from "react";
import { PanelHeaderActions } from "../../ui/PanelShell";
import { useInPanelShell } from "../../ui/panelSlots";
import "../../tokens.css";
import "../../ui/orbit-ui.css";
import "./panels.css";

/* Body-side building blocks for the Orbit task panels. Loading, error and
   whole-panel empty states come from the shell (PanelLoading, PanelError,
   PanelEmpty in ../../ui/PanelShell). */

/** Panel body root: carries the Orbit tokens and fills the shell's body box. */
export function PanelBody({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <div className={`owp orbit-ui${className ? ` ${className}` : ""}`} aria-label={label} role="region">
      {children}
    </div>
  );
}

/**
 * Header buttons: portaled into the shell header when there is one,
 * otherwise `fallback` (or the same buttons) renders in place in the body.
 */
export function HeaderActions({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  const inShell = useInPanelShell();
  if (inShell) return <PanelHeaderActions>{children}</PanelHeaderActions>;
  return <>{fallback === undefined ? children : fallback}</>;
}

/** Section: muted label (+ hint and trailing actions), then its content. */
export function PanelSection({ label, hint, end, children }: { label: string; hint?: ReactNode; end?: ReactNode; children: ReactNode }) {
  return (
    <section className="owp-sec">
      <h3 className="owp-label">
        <span>{label}</span>
        {hint !== undefined && hint !== null ? <small>{hint}</small> : null}
        {end ? <span className="owp-label-end">{end}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** Long list cap with a "Show all" footer. */
export function ShowMore({ shown, total, onToggle, expanded }: { shown: number; total: number; onToggle: () => void; expanded: boolean }) {
  if (total <= shown && !expanded) return null;
  return (
    <button type="button" className="owp-more" onClick={onToggle} aria-expanded={expanded}>
      {expanded ? "Show fewer" : `Show all ${total}`}
    </button>
  );
}
