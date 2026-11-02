import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import type { PageHue } from "./PageHeader";

/* Building blocks shared by Orbit's one-viewport pages: the page shell and
   header, the card, the empty state and the status dot. */

function hueStyle(hue: PageHue): CSSProperties {
  return {
    "--oui-hue-a": hue.from,
    "--oui-hue-b": hue.to,
    "--oui-hue-strong": hue.strong,
    "--oui-page-glow": hue.glow,
  } as CSSProperties;
}

interface OrbitPageProps {
  /** Page root class (its CSS prefix), e.g. "odb". */
  className: string;
  hue?: PageHue;
  /** Content of the centered column: header, strips, the card grid. */
  children: ReactNode;
  /** Outside the column (dialogs, portaled sheets). */
  overlays?: ReactNode;
  style?: CSSProperties;
}

/**
 * One-viewport page: a centered column whose header and strips take their
 * height and whose last child (the card grid) fills the rest. Long lists
 * scroll inside their cards; below 860px the page scrolls instead.
 */
export function OrbitPage({ className, hue, children, overlays, style }: OrbitPageProps) {
  return (
    <MotionConfig reducedMotion="user">
      <div className={`oui-page orbit-ui ${className}`} style={hue ? { ...hueStyle(hue), ...style } : style}>
        <div className="oui-page-inner">{children}</div>
        {overlays}
      </div>
    </MotionConfig>
  );
}

/** Page with nothing to show yet (no project selected). */
export function OrbitPageMessage({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={`oui-page orbit-ui ${className}`}>
      <p className="oui-page-message">{children}</p>
    </div>
  );
}

interface OrbitPageHeaderProps {
  /** Glyph tile icon (tinted by the page hue). */
  icon: LucideIcon;
  title: ReactNode;
  /** Tooltip for a truncated title. */
  titleHint?: string;
  /** Inline after the title (e.g. a branch pill). */
  titleAside?: ReactNode;
  subtitle?: ReactNode;
  subtitleHint?: string;
  mono?: boolean;
  /** Right side: chips, segmented controls, buttons. */
  actions?: ReactNode;
  /** Lift above later siblings' animation layers (popovers open from here). */
  raised?: boolean;
}

export function OrbitPageHeader({ icon: Icon, title, titleHint, titleAside, subtitle, subtitleHint, mono = false, actions, raised = false }: OrbitPageHeaderProps) {
  return (
    <header className={`oui-page-head oui-rise${raised ? " oui-layer-top" : ""}`}>
      <span className="oui-glyph" aria-hidden="true"><Icon /></span>
      <div className="oui-page-head-copy">
        <div className="oui-page-title">
          <h1 className="oui-truncate" title={titleHint}>{title}</h1>
          {titleAside}
        </div>
        {subtitle ? <p className={`oui-truncate${mono ? " oui-mono" : ""}`} title={subtitleHint}>{subtitle}</p> : null}
      </div>
      {actions ? <div className="oui-page-actions">{actions}</div> : null}
    </header>
  );
}

interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Head title; omit (with `head`) for a headless card. */
  title?: ReactNode;
  /** Muted note after the title. */
  hint?: ReactNode;
  /** Right side of the head. */
  actions?: ReactNode;
  /** Replaces the title (e.g. a search field filling the head). */
  head?: ReactNode;
  children?: ReactNode;
}

/** Card: hairline, rounded, raised a step. The head stays; the body below scrolls inside. */
export function Card({ title, hint, actions, head, className, children, ...rest }: CardProps) {
  const hasHead = title !== undefined || head !== undefined || actions !== undefined;
  return (
    <section className={`oui-card${className ? ` ${className}` : ""}`} {...rest}>
      {hasHead ? (
        <div className="oui-card-head">
          {head ?? <h2>{title}{hint !== undefined && hint !== null ? <small>{hint}</small> : null}</h2>}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

interface EmptyStateProps {
  icon?: LucideIcon;
  /** `hue` tints the tile with the page hue (page-level empties); `error` for failures. */
  tone?: "neutral" | "hue" | "error";
  title?: ReactNode;
  children?: ReactNode;
  /** Buttons under the copy. */
  action?: ReactNode;
  /** `lg` for a whole page or card with nothing in it yet. */
  size?: "md" | "lg";
  className?: string;
  role?: string;
  style?: CSSProperties;
}

/** Centered glyph tile + title + body + call to action. */
export function EmptyState({ icon: Icon, tone = "neutral", title, children, action, size = "md", className, role, style }: EmptyStateProps) {
  return (
    <div className={`oui-empty${size === "lg" ? " is-lg" : ""}${className ? ` ${className}` : ""}`} role={role} style={style}>
      {Icon ? <span className={`oui-empty-ic is-${tone}`} aria-hidden="true"><Icon /></span> : null}
      {title ? <b>{title}</b> : null}
      {children ? <span className="oui-empty-body">{children}</span> : null}
      {action ? <div className="oui-empty-acts">{action}</div> : null}
    </div>
  );
}

export type StatusTone = "live" | "waiting" | "ok" | "fail" | "warn" | "info" | "off" | "idle";

interface StatusDotProps {
  tone: StatusTone;
  /** `sm` inline in text (6px), `md` default (7px), `lg` leading a row (10px). */
  size?: "sm" | "md" | "lg";
  /** Soft halo around the dot. */
  ring?: boolean;
  pulse?: boolean;
  label?: string;
  title?: string;
  className?: string;
}

/** Status dot: color carries the state; live ones can breathe. */
export function StatusDot({ tone, size = "md", ring = false, pulse = false, label, title, className }: StatusDotProps) {
  return (
    <span
      className={`oui-dot is-${tone} is-${size}${ring ? " has-ring" : ""}${pulse ? " is-pulse" : ""}${className ? ` ${className}` : ""}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={title}
    />
  );
}
