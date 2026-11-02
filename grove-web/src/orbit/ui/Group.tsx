import type { ReactNode } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";

interface GroupProps {
  title?: string;
  /** Short muted sentence shown inline after the title. */
  hint?: ReactNode;
  /** Right side of the label line (e.g. a refresh button). */
  actions?: ReactNode;
  /** Muted note under the card. */
  footnote?: ReactNode;
  /** Scroll anchor id for nav sub-sections (read by the scroll-spy). */
  anchorId?: string;
  children: ReactNode;
}

export function Group({ title, hint, actions, footnote, anchorId, children }: GroupProps) {
  return (
    <div className="oui-gwrap" data-anchor={anchorId}>
      {title || actions ? (
        <div className="oui-glabel">
          {title}
          {hint ? <small>{hint}</small> : null}
          {actions ? <span className="oui-glabel-actions">{actions}</span> : null}
        </div>
      ) : null}
      <div className="oui-group">{children}</div>
      {footnote ? <p className="oui-footnote">{footnote}</p> : null}
    </div>
  );
}

interface RowProps {
  title: ReactNode;
  description?: ReactNode;
  /** Neutral icon tile / dot before the copy. */
  leading?: ReactNode;
  /** Right-side control. */
  children?: ReactNode;
  /** Renders the whole row as a button with a trailing chevron. */
  onClick?: () => void;
  /** Renders the whole row as an external link (new tab). */
  href?: string;
  mono?: boolean;
  dim?: boolean;
}

export function Row({ title, description, leading, children, onClick, href, mono = false, dim = false }: RowProps) {
  const copy = (
    <span className="oui-row-copy">
      <span className={`oui-row-title${mono ? " oui-mono" : ""}`}>{title}</span>
      {description ? <span className={`oui-row-desc${mono ? " oui-mono" : ""}`}>{description}</span> : null}
    </span>
  );
  const className = `oui-row${dim ? " is-dim" : ""}`;
  if (href) {
    return (
      <a className={`${className} oui-row-link`} href={href} target="_blank" rel="noopener noreferrer">
        {leading}
        {copy}
        {children}
        <ArrowUpRight className="oui-i oui-chev" aria-hidden="true" />
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={`${className} oui-row-link`} onClick={onClick}>
        {leading}
        {copy}
        {children}
        <ChevronRight className="oui-i oui-chev" aria-hidden="true" />
      </button>
    );
  }
  return (
    <div className={className} aria-disabled={dim || undefined}>
      {leading}
      {copy}
      {children ? <div className="oui-row-control">{children}</div> : null}
    </div>
  );
}

/** Free-form content inside a Group, separated like a row. */
export function Block({ children, dim = false }: { children: ReactNode; dim?: boolean }) {
  return <div className={`oui-block${dim ? " is-dim" : ""}`}>{children}</div>;
}

export function Lead({ children }: { children: ReactNode }) {
  return <span className="oui-lead" aria-hidden="true">{children}</span>;
}
