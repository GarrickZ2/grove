import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, Check, ChevronDown, CircleAlert, ExternalLink, FolderSearch, X } from "lucide-react";
import { getTauriInternals } from "../utils/tauri";
import { formatSize } from "../components/ui/FileListUtils";
import { revealLabel } from "../orbit/studio/studioView";
import { openSavedFile, revealSavedFile } from "./download";
import { cancelTransfer, clearFinishedTransfers, useTransfers, type Transfer } from "./store";

function fraction(item: Transfer): number | null {
  return item.total ? Math.min(1, item.loaded / item.total) : null;
}

function detail(item: Transfer): string {
  switch (item.status) {
    case "active":
      if (item.total) return `${formatSize(item.loaded)} of ${formatSize(item.total)}`;
      if (item.loaded === 0) return item.kind === "upload" ? "Waiting…" : "Preparing…";
      return formatSize(item.loaded);
    case "done":
      if (item.path) return item.path;
      return item.kind === "upload" ? "Uploaded" : "Saved to your browser's downloads";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return item.error ?? "Failed";
  }
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-bg-tertiary)]"
      style={{ color: "var(--color-text-muted)" }}
    >
      {children}
    </button>
  );
}

function TransferRow({ item }: { item: Transfer }) {
  const tauri = getTauriInternals();
  const share = fraction(item);
  const Direction = item.kind === "upload" ? ArrowUp : ArrowDown;
  const failed = item.status === "failed";
  return (
    <li className="flex items-center gap-2.5 px-3 py-2">
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{ background: "var(--color-bg-tertiary)", color: failed ? "var(--color-error)" : "var(--color-text-muted)" }}
      >
        {failed ? <CircleAlert className="h-3.5 w-3.5" /> : item.status === "done" ? <Check className="h-3.5 w-3.5" /> : <Direction className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" style={{ color: "var(--color-text)" }} title={item.name}>{item.name}</p>
        {item.status === "active" && (
          <div
            role="progressbar"
            aria-label={item.name}
            aria-valuenow={share === null ? undefined : Math.round(share * 100)}
            className="my-1 h-1 overflow-hidden rounded-full"
            style={{ background: "var(--color-bg-tertiary)" }}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-150 ${share === null ? "w-1/3 animate-pulse" : ""}`}
              style={{ background: "var(--color-highlight)", ...(share === null ? {} : { width: `${share * 100}%` }) }}
            />
          </div>
        )}
        <p className="truncate text-[11px]" style={{ color: failed ? "var(--color-error)" : "var(--color-text-muted)" }} title={detail(item)}>{detail(item)}</p>
      </div>
      {item.status === "active" && (
        <IconButton label={`Cancel ${item.name}`} onClick={() => cancelTransfer(item.id)}><X className="h-3.5 w-3.5" /></IconButton>
      )}
      {item.status === "done" && item.path && tauri && (
        <>
          <IconButton label="Open" onClick={() => void openSavedFile(tauri, item.path as string)}><ExternalLink className="h-3.5 w-3.5" /></IconButton>
          <IconButton label={revealLabel()} onClick={() => void revealSavedFile(tauri, item.path as string)}><FolderSearch className="h-3.5 w-3.5" /></IconButton>
        </>
      )}
    </li>
  );
}

function summary(items: Transfer[]): string {
  const active = items.filter((item) => item.status === "active");
  if (active.length > 0) {
    const known = active.filter((item) => item.total);
    const total = known.reduce((sum, item) => sum + (item.total ?? 0), 0);
    const loaded = known.reduce((sum, item) => sum + item.loaded, 0);
    const percent = total > 0 ? ` · ${Math.round((loaded / total) * 100)}%` : "";
    return `${active.length} ${active.length === 1 ? "transfer" : "transfers"}${percent}`;
  }
  const failed = items.filter((item) => item.status === "failed").length;
  return failed > 0 ? `${failed} failed` : `${items.length} finished`;
}

/** Uploads and downloads of this session. Lives in memory; a reload clears it. */
export function TransferDock() {
  const items = useTransfers();
  const [open, setOpen] = useState(true);
  const activeCount = items.filter((item) => item.status === "active").length;
  const previousActive = useRef(0);
  useEffect(() => {
    // A new transfer is worth showing, even if the list was folded away.
    if (activeCount > previousActive.current) setOpen(true);
    previousActive.current = activeCount;
  }, [activeCount]);
  const newestFirst = useMemo(() => [...items].reverse(), [items]);
  if (items.length === 0) return null;
  return createPortal(
    <AnimatePresence>
      <motion.section
        aria-label="Transfers"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className="fixed bottom-4 right-4 z-[10000] w-[min(340px,calc(100vw-32px))] overflow-hidden rounded-xl border shadow-lg"
        style={{ background: "var(--color-bg)", borderColor: "var(--color-border)" }}
      >
        <header className="flex items-center gap-1 py-1.5 pl-3 pr-1.5">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium"
            style={{ color: "var(--color-text)" }}
          >
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} style={{ color: "var(--color-text-muted)" }} />
            <span className="truncate">{summary(items)}</span>
          </button>
          {activeCount < items.length && (
            <IconButton label="Clear finished" onClick={clearFinishedTransfers}><X className="h-3.5 w-3.5" /></IconButton>
          )}
        </header>
        {open && (
          <ul className="max-h-[320px] overflow-y-auto border-t" style={{ borderColor: "var(--color-border)" }}>
            {newestFirst.map((item) => <TransferRow key={item.id} item={item} />)}
          </ul>
        )}
      </motion.section>
    </AnimatePresence>,
    document.body,
  );
}
