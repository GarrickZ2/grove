import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { applyPluginUpdate, discardPluginUpdate, type PluginUpdate } from "../../api/plugins";
import { Button } from "../ui";
import { PluginReviewSection } from "./PluginReview";

function ChangeList({ title, items, tone }: { title: string; items: string[]; tone: "add" | "remove" | "change" }) {
  if (items.length === 0) return null;
  const color = tone === "add" ? "var(--color-warning)" : "var(--color-text-secondary)";
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-[var(--color-text-muted)]">{title}</span>
      {items.map((item) => <code key={item} className="rounded bg-[var(--color-bg-secondary)] px-1.5 py-0.5" style={{ color }}>{item}</code>)}
    </div>
  );
}

/** A staged version: what differs from the running one, and the choice to take it. */
export function PluginUpdateSection({ pluginId, update, onDone }: { pluginId: string; update: PluginUpdate; onDone: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { changes } = update;
  const fileCount = changes.files.added + changes.files.removed + changes.files.changed;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The update failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-6 rounded-xl border border-[var(--color-highlight)]/30 bg-[var(--color-highlight)]/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
        Update ready
        <span className="inline-flex items-center gap-1 text-xs font-normal text-[var(--color-text-muted)]">
          v{update.from}<ArrowRight className="h-3 w-3" />v{update.to}
        </span>
      </div>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">The current version keeps running until you update.</p>
      <div className="mt-3 space-y-1.5">
        <ChangeList title="New permissions" items={changes.permissions_added} tone="add" />
        <ChangeList title="Removed permissions" items={changes.permissions_removed} tone="remove" />
        <ChangeList title="New capabilities" items={changes.contributions_added} tone="add" />
        <ChangeList title="Changed capabilities" items={changes.contributions_changed} tone="change" />
        <ChangeList title="Removed capabilities" items={changes.contributions_removed} tone="remove" />
        <p className="text-xs text-[var(--color-text-muted)]">
          {fileCount === 0 ? "No files changed." : `${changes.files.changed} changed, ${changes.files.added} added, ${changes.files.removed} removed files.`}
        </p>
      </div>
      <h4 className="mt-4 text-xs font-semibold text-[var(--color-text)]">What the new version can do</h4>
      <PluginReviewSection review={update.review} status="active" />
      {error && <p role="alert" className="mt-3 text-xs text-[var(--color-error)]">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void run(() => discardPluginUpdate(pluginId))}>Keep current version</Button>
        <Button variant="primary" size="sm" disabled={busy || !update.digest} onClick={() => void run(() => applyPluginUpdate(pluginId, update.digest))}>Update to v{update.to}</Button>
      </div>
    </section>
  );
}
