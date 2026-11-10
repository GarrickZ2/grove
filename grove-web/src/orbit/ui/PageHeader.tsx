import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export interface PageHue {
  /** Gradient start / end for the glyph tile. */
  from: string;
  to: string;
  /** Faint wash used for the content glow. */
  glow: string;
  /** Stronger tint used for the tile's soft drop glow. */
  strong: string;
}

interface PageHeaderProps {
  icon: LucideIcon;
  hue: PageHue;
  title: string;
  /** Collapse into the compact frosted bar (content scrolled under it). */
  condensed?: boolean;
  /** Right-aligned slot (status chips, Saved, actions). */
  aside?: ReactNode;
}

export function PageHeader({ icon: Icon, hue, title, condensed = false, aside }: PageHeaderProps) {
  const style = {
    "--oui-hue-a": hue.from,
    "--oui-hue-b": hue.to,
    "--oui-hue-strong": hue.strong,
  } as CSSProperties;
  return (
    <header className={`oui-hdr${condensed ? " is-condensed" : ""}`} style={style}>
      {/* Keyed by title so the tile pops in again when the page changes. */}
      <span key={title} className="oui-glyph" aria-hidden="true">
        <Icon />
      </span>
      <div className="oui-hdr-copy">
        <h1>{title}</h1>
      </div>
      {aside ? <div className="oui-hdr-aside">{aside}</div> : null}
    </header>
  );
}
