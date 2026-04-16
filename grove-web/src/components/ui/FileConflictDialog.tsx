import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface FileConflictDialogProps {
  /** The filename that caused the conflict */
  fileName: string;
  /** Current value of the "Save as" input */
  newName: string;
  /** Set of filenames that already exist at the destination */
  existingNames: Set<string>;
  onNewNameChange: (v: string) => void;
  onCancel: () => void;
  /** Called when the user chooses to overwrite the existing file */
  onOverwrite: () => void;
  /** Called when the user chooses to save under a different name */
  onRename: () => void;
}

/**
 * Shared conflict dialog for file move / sync operations.
 *
 * - If the current input name matches an existing file  → button shows "Overwrite"
 * - If the current input name is new                   → button shows "Rename"
 */
export function FileConflictDialog({
  fileName,
  newName,
  existingNames,
  onNewNameChange,
  onCancel,
  onOverwrite,
  onRename,
}: FileConflictDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(id);
  }, []);

  const trimmed = newName.trim();
  const isOverwrite = trimmed !== "" && existingNames.has(trimmed);
  const canConfirm = trimmed !== "";

  const handleConfirm = () => {
    if (!canConfirm) return;
    if (isOverwrite) onOverwrite();
    else onRename();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onCancel}
    >
      <div
        className="w-80 rounded-2xl border p-5 shadow-2xl flex flex-col gap-4"
        style={{ background: "var(--color-bg)", borderColor: "var(--color-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
            File already exists
          </p>
          <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
            <span className="font-mono">{fileName}</span> already exists at the destination.
            Choose what to do:
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium" style={{ color: "var(--color-text-muted)" }}>
            Save as
          </label>
          <input
            ref={inputRef}
            value={newName}
            onChange={(e) => onNewNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConfirm();
              if (e.key === "Escape") onCancel();
            }}
            className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
            style={{
              background: "var(--color-bg-secondary)",
              borderColor: "var(--color-border)",
              color: "var(--color-text)",
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "var(--color-highlight)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
          />
          {isOverwrite && (
            <p className="text-[11px] mt-1" style={{ color: "var(--color-warning)" }}>
              This will replace the existing file.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-text-muted)",
              background: "var(--color-bg-secondary)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--color-text-muted)")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--color-border)")}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed border"
            style={
              isOverwrite
                ? {
                    borderColor: "var(--color-warning)",
                    color: "var(--color-warning)",
                    background: "color-mix(in srgb, var(--color-warning) 8%, transparent)",
                  }
                : { borderColor: "transparent", background: "var(--color-highlight)", color: "white" }
            }
            onMouseEnter={(e) => {
              if (canConfirm) e.currentTarget.style.opacity = "0.85";
            }}
            onMouseLeave={(e) => {
              if (canConfirm) e.currentTarget.style.opacity = "1";
            }}
          >
            {isOverwrite ? "Overwrite" : "Rename"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * State shape for tracking an in-progress file conflict resolution.
 */
export interface FileConflictState {
  /** Relative path of the file being moved/copied */
  fromPath: string;
  /** Target folder path (not including filename) */
  toFolderPath: string;
  /** Current "Save as" input value */
  newName: string;
  /** Set of filenames that already exist in the target folder */
  existingNames: Set<string>;
}
