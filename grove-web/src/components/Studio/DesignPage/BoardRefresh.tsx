import { useState } from "react";
import { RefreshCw } from "lucide-react";

/** Read the board's files and comments again: the Design and Sketch panels stay
 *  mounted between visits, so this is how their reader asks for what is there now. */
export function BoardRefresh({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="design-icon-btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onRefresh();
        } finally {
          setBusy(false);
        }
      }}
      title="Refresh"
      aria-label="Refresh"
    >
      <RefreshCw size={14} className={busy ? "design-spin" : undefined} />
    </button>
  );
}
