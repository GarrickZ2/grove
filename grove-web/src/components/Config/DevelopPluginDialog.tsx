import { useState } from "react";
import { createPortal } from "react-dom";
import { Code, FolderOpen, X } from "lucide-react";
import { Button } from "../ui";
import { scaffoldPlugin } from "../../api/plugins";
import { useBrowseFolder } from "../Projects/useBrowseFolder";

/**
 * "Develop Plugin" dialog: enter a plugin name, pick a parent folder, and the
 * backend scaffolds a starter plugin into `<parent>/<name>/`, then auto-registers
 * it as a dev plugin.
 */
export function DevelopPluginDialog({ onClose }: { onClose: () => void }) {
  const { browseFolder, folderPicker } = useBrowseFolder("Select Plugin Parent Folder");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; path: string; next?: string } | null>(null);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please enter a plugin name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const path = await browseFolder();
      if (!path) {
        setBusy(false);
        return; // user cancelled the folder picker
      }
      const res = await scaffoldPlugin(path, trimmed);
      setDone({ name: res.name, path: res.path, next: res.next });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Code className="h-4 w-4 text-[var(--color-highlight)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Develop a Plugin</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {done ? (
          <div className="space-y-3">
            <div className="break-all rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/5 px-3 py-2 text-xs text-[var(--color-text)]">
              Created “{done.name}” at {done.path}
            </div>
            <p className="text-xs text-[var(--color-text-muted)]">
              It's a vite + TypeScript project. Build the shippable{" "}
              <code className="text-[var(--color-highlight)]">dist/</code> first, then hit
              Reload in the panel:
            </p>
            {done.next && (
              <pre className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[11px] text-[var(--color-text)]">
                {done.next}
              </pre>
            )}
            <p className="text-xs text-[var(--color-text-muted)]">
              See the generated <code className="text-[var(--color-highlight)]">README.md</code>{" "}
              and <code className="text-[var(--color-highlight)]">docs/</code> for the SDK and
              manifest reference.
            </p>
            <div className="flex justify-end">
              <Button variant="primary" size="sm" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs text-[var(--color-text-muted)]">
                Plugin name
              </label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-grove-plugin"
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
              />
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                A folder named{" "}
                <code className="text-[var(--color-highlight)]">
                  {name.trim() || "my-grove-plugin"}
                </code>{" "}
                will be created inside the folder you choose next.
              </p>
            </div>

            {error && (
              <div className="break-all rounded-lg border border-[var(--color-error)]/30 bg-[var(--color-error)]/5 px-3 py-2 text-xs text-[var(--color-error)]">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleCreate} disabled={busy}>
                <FolderOpen className="mr-1.5 h-4 w-4" />
                {busy ? "Creating…" : "Choose folder & create"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
      )}
      {folderPicker}
    </>
  );
}
