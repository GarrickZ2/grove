import { memo, type MouseEvent } from "react";
import { Archive, History } from "lucide-react";
import type { ChatReadOnly } from "../../../../api";
import { readOnlyCopy } from "./readOnlyCopy";

/**
 * Takes the composer's place on a read-only Session: why nothing can be sent,
 * and the two ways forward.
 */
export const OrbitReadOnlyCard = memo(function OrbitReadOnlyCard({
  readonly,
  agentName,
  onContinue,
  onArchive,
}: {
  readonly: ChatReadOnly;
  agentName: string;
  onContinue?: (anchor: HTMLElement) => void;
  onArchive?: () => void;
}) {
  const { title, detail } = readOnlyCopy(readonly, agentName);
  return (
    <div className="ocv-readonly" role="status" aria-live="polite">
      <span className="ocv-readonly-icon" aria-hidden="true"><History /></span>
      <div className="ocv-readonly-text">
        <div className="ocv-readonly-title">{title}</div>
        <div className="ocv-readonly-detail">{detail}</div>
      </div>
      <div className="ocv-readonly-actions">
        {onArchive && (
          <button type="button" className="ocv-btn is-plain" onClick={onArchive}>
            <Archive aria-hidden="true" />
            Archive
          </button>
        )}
        {onContinue && (
          <button
            type="button"
            className="ocv-btn is-primary"
            title="Start a new session with this history shared"
            onClick={(event: MouseEvent<HTMLButtonElement>) => onContinue(event.currentTarget)}
          >
            Continue in new session
          </button>
        )}
      </div>
    </div>
  );
});
