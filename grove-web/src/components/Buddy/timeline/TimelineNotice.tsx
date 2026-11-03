import type { ReactNode } from "react";
import { MessageSquareText } from "lucide-react";
import type { NoticeTone } from "./promptEvents";

/**
 * A centered line for something that happened between messages: a subagent
 * reporting back, a Routine running or changing, and later other Buddies
 * messaging this one ("Message from <avatar> Name"). A muted lead says what
 * happened; the chip names who or what, and opens it when clickable.
 */
export function TimelineNotice({ lead, icon, name, tone = "neutral", onClick, label, detail }: { lead: string; icon?: ReactNode; name?: string; tone?: NoticeTone; onClick?: () => void; label?: string; detail?: string }) {
  const chip = <>{icon}<span className="buddy-notice-name">{name}</span></>;
  return <div className={`buddy-notice is-${tone}${detail ? " has-detail" : ""}`}>
    <span>{lead}</span>
    {name && (onClick
      ? <button type="button" className="buddy-notice-chip" onClick={onClick} aria-label={label}>{chip}</button>
      : <span className="buddy-notice-chip">{chip}</span>)}
    {/* The exact message, on hover or keyboard focus. */}
    {detail && <span className="buddy-notice-detail" tabIndex={0} aria-label={`${lead} ${name ?? ""}: ${detail}`}><MessageSquareText size={13} aria-hidden="true" /><span className="buddy-notice-popover" role="tooltip">{detail}</span></span>}
  </div>;
}
