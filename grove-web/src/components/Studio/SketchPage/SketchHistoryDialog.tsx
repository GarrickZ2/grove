import { useEffect, useState } from "react";
import { History, RotateCcw, Clock, AlertTriangle } from "lucide-react";
import {
  listSketchHistory,
  restoreSketchCheckpoint,
  type SketchHistoryEntry,
} from "../../../api";
import { DialogShell } from "../../ui/DialogShell";
import { Button } from "../../ui";

interface Props {
  isOpen: boolean;
  projectId: string;
  taskId: string;
  sketchId: string;
  sketchName: string;
  onClose: () => void;
  /** Fired after a successful restore so the page can trigger a refetch. */
  onRestored: () => void;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export function SketchHistoryDialog({
  isOpen,
  projectId,
  taskId,
  sketchId,
  sketchName,
  onClose,
  onRestored,
}: Props) {
  const [entries, setEntries] = useState<SketchHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !sketchId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listSketchHistory(projectId, taskId, sketchId)
      .then((data) => {
        if (cancelled) return;
        setEntries(data);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load history");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId, taskId, sketchId]);

  const doRestore = async (checkpointId: string) => {
    setRestoringId(checkpointId);
    setError(null);
    try {
      await restoreSketchCheckpoint(projectId, taskId, sketchId, checkpointId);
      onRestored();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore failed");
    } finally {
      setRestoringId(null);
      setConfirmId(null);
    }
  };

  const confirmTarget = confirmId
    ? entries?.find((e) => e.id === confirmId) ?? null
    : null;

  return (
    <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-xl">
      <div
        className="flex flex-col max-h-[80vh]"
        style={{ background: "var(--color-bg)", color: "var(--color-text)" }}
      >
        <div
          className="flex items-center gap-2 px-5 py-4 border-b"
          style={{ borderColor: "var(--color-border)" }}
        >
          <History className="w-4 h-4" style={{ color: "var(--color-highlight)" }} />
          <div className="flex flex-col">
            <div className="text-sm font-semibold">Sketch History</div>
            <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              Restore a previous version of <span className="font-medium">{sketchName}</span>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-2 py-2">
          {loading && (
            <div className="p-6 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
              Loading history…
            </div>
          )}
          {!loading && error && (
            <div
              className="m-2 p-3 rounded-md text-xs flex items-start gap-2"
              style={{
                background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
                color: "var(--color-error)",
              }}
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>{error}</div>
            </div>
          )}
          {!loading && !error && entries && (
            <>
              {entries.length === 0 && (
                <div
                  className="p-6 text-center text-sm"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  No checkpoints available for this sketch yet.
                  <br />
                  Each AI draw creates a checkpoint — come back after the next agent edit.
                </div>
              )}
              {entries.map((e) => (
                <HistoryRow
                  key={e.id}
                  entry={e}
                  disabled={restoringId !== null}
                  isRestoring={restoringId === e.id}
                  onRestore={() => setConfirmId(e.id)}
                />
              ))}
            </>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 px-5 py-3 border-t"
          style={{ borderColor: "var(--color-border)" }}
        >
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      {confirmTarget && (
        <DialogShell
          isOpen
          onClose={() => setConfirmId(null)}
          maxWidth="max-w-sm"
          zIndex={60}
        >
          <div
            className="p-5 flex flex-col gap-3"
            style={{ background: "var(--color-bg)", color: "var(--color-text)" }}
          >
            <div className="flex items-center gap-2">
              <AlertTriangle
                className="w-4 h-4"
                style={{ color: "var(--color-warning)" }}
              />
              <div className="text-sm font-semibold">Restore this checkpoint?</div>
            </div>
            <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              This overwrites the current scene of{" "}
              <span className="font-medium">{sketchName}</span> with the version from{" "}
              {formatTimestamp(confirmTarget.ts)}. The overwritten state is not
              automatically backed up — if you need it later, open History again and
              restore the most recent entry.
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => setConfirmId(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  void doRestore(confirmTarget.id);
                }}
                disabled={restoringId !== null}
              >
                {restoringId === confirmTarget.id ? "Restoring…" : "Restore"}
              </Button>
            </div>
          </div>
        </DialogShell>
      )}
    </DialogShell>
  );
}

interface RowProps {
  entry: SketchHistoryEntry;
  disabled: boolean;
  isRestoring: boolean;
  onRestore: () => void;
}

function HistoryRow({ entry, disabled, isRestoring, onRestore }: RowProps) {
  return (
    <div
      className="flex items-start gap-3 px-3 py-2 rounded-md transition-colors"
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--color-bg-tertiary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <Clock
        className="w-3.5 h-3.5 mt-1 shrink-0"
        style={{ color: "var(--color-text-muted)" }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium">{formatTimestamp(entry.ts)}</div>
        <div
          className="text-[11px] truncate"
          style={{ color: "var(--color-text-muted)" }}
        >
          {/* `label` now holds a type breakdown like "2 rectangle · 1 arrow".
              It already encodes the total via its own sum, so we hide the
              redundant `N elements` prefix when the breakdown is present. */}
          {entry.label ? (
            <>{entry.label}</>
          ) : entry.element_count != null ? (
            <>{entry.element_count} elements</>
          ) : (
            <span className="italic opacity-70">no preview</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onRestore}
        disabled={disabled}
        className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors border"
        style={{
          borderColor: "var(--color-border)",
          color: "var(--color-text)",
          background: "var(--color-bg-secondary)",
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        <RotateCcw className="w-3 h-3" />
        {isRestoring ? "Restoring…" : "Restore"}
      </button>
    </div>
  );
}
