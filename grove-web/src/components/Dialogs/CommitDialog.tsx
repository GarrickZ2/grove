import { useCallback, useEffect, useState } from "react";
import { GitCommit, X, Loader2 } from "lucide-react";
import { Button } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { formatKeyDisplay, useCommand, useContextKey, useKeyboardScope } from "../../keyboard";
import { useOrbitInterface } from "../../orbit/ui/interfaceContext";
import { Button as OrbitButton } from "../../orbit/ui/Button";
import { DialogBody, DialogFoot, DialogHead, DialogPanel } from "../../orbit/ui/Dialog";

interface CommitDialogProps {
  isOpen: boolean;
  isLoading?: boolean;
  error?: string | null;
  onCommit: (message: string) => void;
  onCancel: () => void;
}

export function CommitDialog({
  isOpen,
  isLoading = false,
  error = null,
  onCommit,
  onCancel,
}: CommitDialogProps) {
  const [message, setMessage] = useState("");

  // Reset message when dialog opens
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMessage("");
    }
  }, [isOpen]);

  // Catalog handlers register inside <CommitDialogBindings> only while
  // isOpen=true. Multiple CommitDialog wrappers can coexist (TaskOperation
  // dialogs mount several at once, all but one with isOpen=false); a
  // top-level useCommand would otherwise overwrite each other on every
  // re-render — only the last-mounted dialog's binding would be live.
  useKeyboardScope("dialog.commit", isOpen);
  const orbit = useOrbitInterface();

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (message.trim() && !isLoading) {
        onCommit(message.trim());
      }
    },
    [message, isLoading, onCommit],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Cmd/Ctrl + Enter to submit
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      handleSubmit(e);
    }
  };

  if (orbit) {
    return (
      <DialogShell isOpen={isOpen} onClose={onCancel} maxWidth="max-w-[520px]">
        {isOpen && (
          <CommitDialogBindings onCancel={onCancel} onSubmit={handleSubmit} messageNotEmpty={message.trim().length > 0} />
        )}
        <DialogPanel onSubmit={handleSubmit}>
          <DialogHead title="Commit changes" />
          <DialogBody>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-label="Commit message"
              placeholder="Describe your changes…"
              rows={4}
              autoFocus
              className="oui-dlg-textarea"
            />
            {error && <p className="oui-dlg-error" role="alert">{error}</p>}
          </DialogBody>
          <DialogFoot>
            <OrbitButton variant="ghost" onClick={onCancel} disabled={isLoading}>
              Cancel
            </OrbitButton>
            <OrbitButton type="submit" variant="primary" disabled={!message.trim() || isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="oui-spin" aria-hidden="true" />
                  Committing…
                </>
              ) : (
                <>
                  Commit
                  <kbd>{formatKeyDisplay("Mod+Enter")}</kbd>
                </>
              )}
            </OrbitButton>
          </DialogFoot>
        </DialogPanel>
      </DialogShell>
    );
  }

  return (
    <DialogShell isOpen={isOpen} onClose={onCancel} maxWidth="max-w-lg">
      {isOpen && (
        <CommitDialogBindings onCancel={onCancel} onSubmit={handleSubmit} messageNotEmpty={message.trim().length > 0} />
      )}
      <form
        onSubmit={handleSubmit}
        className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-highlight)]/10">
              <GitCommit className="w-5 h-5 text-[var(--color-highlight)]" />
            </div>
            <h2 className="text-lg font-semibold text-[var(--color-text)]">Commit Changes</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4">
          <label className="block text-sm font-medium text-[var(--color-text)] mb-2">
            Commit Message
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your changes..."
            rows={4}
            autoFocus
            className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-highlight)] focus:border-transparent resize-none font-mono text-sm"
          />
          <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
            Press Cmd/Ctrl + Enter to commit
          </p>
          {error && (
            <p className="mt-2 text-sm text-[var(--color-error)]">{error}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button type="submit" disabled={!message.trim() || isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                Committing...
              </>
            ) : (
              <>
                <GitCommit className="w-4 h-4 mr-1.5" />
                Commit
              </>
            )}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}

// Registers the git.commit.* catalog handlers only while the dialog is
// actually open. See top-of-component comment for the multi-mount rationale.
function CommitDialogBindings({
  onCancel,
  onSubmit,
  messageNotEmpty,
}: {
  onCancel: () => void;
  onSubmit: () => void;
  messageNotEmpty: boolean;
}) {
  // git.commit.submit gates on a non-empty commit message.
  useContextKey("commitMessageNotEmpty", messageNotEmpty);
  useCommand("git.commit.cancel", onCancel, [onCancel]);
  useCommand("git.commit.submit", onSubmit, [onSubmit]);
  return null;
}
