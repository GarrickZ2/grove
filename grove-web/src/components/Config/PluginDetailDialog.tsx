import { useState } from "react";
import {
  Blocks,
  CheckCircle2,
  Clock3,
  FolderOpen,
  MessageCircle,
  PanelRight,
  RefreshCw,
  Server,
  ShieldAlert,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { Button, DrawerShell } from "../ui";
import { deletePlugin, updatePluginSdk, type Plugin } from "../../api/plugins";
import { ExtensionIdentityIcon } from "../Skills/ExtensionIdentityIcon";
import { ConfirmDialog } from "../Dialogs";

const HIGH_RISK_PERMISSIONS = new Set(["exec", "project:write", "chat:read", "chat:write", "inject", "connect:provider"]);

const PERMISSION_LABELS: Record<string, string> = {
  "chat:read": "Read chat & AI events",
  "chat:write": "Send prompts to the AI",
  "connect:provider": "Run an IM Connect provider",
};

const permissionLabel = (permission: string) => PERMISSION_LABELS[permission] ?? permission;

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function PluginDetailDialog({ plugin, onClose, onDeleted }: { plugin: Plugin; onClose: () => void; onDeleted?: () => void | Promise<void> }) {
  const [sdkState, setSdkState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [sdkMessage, setSdkMessage] = useState<string | null>(null);
  const [sdkStatus, setSdkStatus] = useState(plugin.sdk_status);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteState, setDeleteState] = useState<"idle" | "running" | "error">("idle");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const updateSdk = async () => {
    setSdkState("running");
    setSdkMessage(null);
    try {
      await updatePluginSdk(plugin.id);
      setSdkState("done");
      setSdkStatus("current");
      setSdkMessage("SDK updated. Rebuild the plugin to apply it.");
    } catch (cause) {
      setSdkState("error");
      setSdkMessage(cause instanceof Error ? cause.message : "Update failed");
    }
  };

  const uninstall = async () => {
    setDeleteState("running");
    setDeleteError(null);
    try {
      await deletePlugin(plugin.id);
      setConfirmDelete(false);
      await onDeleted?.();
      onClose();
    } catch (cause) {
      setDeleteState("error");
      setDeleteError(cause instanceof Error ? cause.message : "Could not uninstall plugin");
    }
  };

  const capabilities = [
    plugin.contributes?.panel && {
      id: "panel",
      icon: PanelRight,
      title: plugin.contributes.panel.title || "Workspace panel",
      detail: plugin.contributes.panel.side ? `${plugin.contributes.panel.side} side` : "Panel contribution",
    },
    plugin.contributes?.sidebar && {
      id: "sidebar",
      icon: Blocks,
      title: plugin.contributes.sidebar.title || "Top-level page",
      detail: "Sidebar contribution",
    },
    plugin.contributes?.mcp && {
      id: "mcp",
      icon: Server,
      title: "MCP server",
      detail: "Provides tools to Grove",
    },
    plugin.contributes?.backend && {
      id: "backend",
      icon: Terminal,
      title: "Node backend",
      detail: "Runs a local backend process",
    },
    Boolean(plugin.contributes?.connectProviders) && {
      id: "connectProviders",
      icon: MessageCircle,
      title: `${plugin.contributes?.connectProviders} IM Connect provider${plugin.contributes?.connectProviders === 1 ? "" : "s"}`,
      detail: "Maintains external messaging connections",
    },
  ].filter(Boolean) as Array<{ id: string; icon: typeof PanelRight; title: string; detail: string }>;

  const runtimeIssue = plugin.exists === false
    ? "Plugin folder is missing"
    : plugin.unbuilt && plugin.unbuilt.length > 0
      ? `Build required: ${plugin.unbuilt.join(", ")}`
      : plugin.runtime && !plugin.runtime.available
        ? `${plugin.runtime.command} is not available on PATH`
        : null;

  return (
    <DrawerShell isOpen onClose={onClose} width="w-[620px]">
      <div className="flex h-full flex-col bg-[var(--color-bg)]">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--color-border)] px-6 py-5">
          <div className="flex min-w-0 items-center gap-3.5">
            <ExtensionIdentityIcon kind="plugin" name={plugin.name} plugin={plugin} />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-lg font-semibold text-[var(--color-text)]">{plugin.name}</h2>
                <span className="shrink-0 text-xs text-[var(--color-text-muted)]">v{plugin.version}</span>
                {plugin.source === "dev" && <span className="shrink-0 rounded-md bg-[var(--color-info)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-info)]">Development</span>}
              </div>
              <p className="mt-1 truncate font-mono text-xs text-[var(--color-text-muted)]">{plugin.id}</p>
            </div>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-lg p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <section>
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Overview</h3>
            <div className="mt-3 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40">
              <OverviewRow icon={FolderOpen} label="Location" value={plugin.local_path} mono />
              <OverviewRow icon={Blocks} label="Source" value={plugin.source === "dev" ? "Development folder" : plugin.source === "git" ? "Git repository" : "Local package"} />
              <OverviewRow icon={Clock3} label="Updated" value={formatTime(plugin.updated_at)} />
            </div>
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Capabilities</h3>
            {capabilities.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">This plugin does not declare any UI or runtime capabilities.</p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {capabilities.map(({ id, icon: Icon, title, detail }) => (
                  <div key={id} className="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--color-border)] px-3 py-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-highlight)]/8 text-[var(--color-highlight)]"><Icon className="h-4 w-4" /></span>
                    <div className="min-w-0"><div className="truncate text-sm font-medium text-[var(--color-text)]">{title}</div><div className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{detail}</div></div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mt-6">
            <div className="flex items-center gap-2"><h3 className="text-sm font-semibold text-[var(--color-text)]">Permissions</h3>{plugin.permissions && plugin.permissions.length > 0 && <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{plugin.permissions.length}</span>}</div>
            {plugin.permissions && plugin.permissions.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {plugin.permissions.map((permission) => {
                  const highRisk = HIGH_RISK_PERMISSIONS.has(permission);
                  return <span key={permission} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${highRisk ? "border-[var(--color-warning)]/25 bg-[var(--color-warning)]/8 text-[var(--color-warning)]" : "border-[var(--color-border)] text-[var(--color-text-secondary)]"}`}>{highRisk && <ShieldAlert className="h-3.5 w-3.5" />}{permissionLabel(permission)}</span>;
                })}
              </div>
            ) : <p className="mt-2 text-sm text-[var(--color-text-muted)]">No permissions requested.</p>}
          </section>

          <section className="mt-6">
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Runtime</h3>
            <div className={`mt-3 flex items-start gap-3 rounded-xl border px-3.5 py-3 ${runtimeIssue ? "border-[var(--color-warning)]/30 bg-[var(--color-warning)]/6" : "border-[var(--color-success)]/25 bg-[var(--color-success)]/6"}`}>
              {runtimeIssue ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" />}
              <div><div className="text-sm font-medium text-[var(--color-text)]">{runtimeIssue || "Ready"}</div>{plugin.runtime && <div className="mt-1 text-xs text-[var(--color-text-muted)]">Command: <code className="text-[var(--color-text-secondary)]">{plugin.runtime.command}</code></div>}</div>
            </div>
          </section>

          {plugin.source === "dev" && (
            <section className="mt-6 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 p-4">
              <div className="flex items-start justify-between gap-5">
                <div><h3 className="text-sm font-semibold text-[var(--color-text)]">Plugin SDK</h3><p className="mt-1 max-w-sm text-xs leading-5 text-[var(--color-text-muted)]">{sdkStatus === "current" ? "Matches the SDK bundled with this Grove build." : sdkStatus === "missing" ? "No Grove SDK was detected in this development plugin." : "The vendored SDK differs from the SDK bundled with this Grove build."}</p></div>
                {sdkStatus === "current" ? <span className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-success)]/10 px-2.5 py-1.5 text-xs font-medium text-[var(--color-success)]"><CheckCircle2 className="h-3.5 w-3.5" />Up to date</span> : <Button variant="secondary" size="sm" onClick={() => void updateSdk()} disabled={sdkState === "running"}><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${sdkState === "running" ? "animate-spin" : ""}`} />{sdkState === "running" ? "Updating…" : sdkStatus === "missing" ? "Install SDK" : "Update SDK"}</Button>}
              </div>
              {sdkMessage && <p className={`mt-3 text-xs ${sdkState === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}>{sdkMessage}</p>}
            </section>
          )}
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 px-6 py-4">
          <div className="min-w-0 text-xs text-[var(--color-text-muted)]">
            {deleteError || (plugin.source === "dev" ? "The development folder will remain on disk." : "Uninstall removes Grove's managed plugin files and data.")}
          </div>
          <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={deleteState === "running"}>
            <Trash2 className="mr-1.5 h-4 w-4" />
            {plugin.source === "dev" ? "Remove" : "Uninstall"}
          </Button>
        </footer>
      </div>
      <ConfirmDialog
        isOpen={confirmDelete}
        title={plugin.source === "dev" ? "Remove development plugin" : "Uninstall plugin"}
        message={plugin.source === "dev" ? `Remove ${plugin.name} from Grove? Its development folder will remain untouched.` : `Uninstall ${plugin.name}? Grove's managed plugin files, runtime, Skills, and plugin data will be removed.`}
        confirmLabel={deleteState === "running" ? "Removing…" : plugin.source === "dev" ? "Remove" : "Uninstall"}
        cancelLabel="Cancel"
        actionsDisabled={deleteState === "running"}
        variant="danger"
        onConfirm={() => void uninstall()}
        onCancel={() => { if (deleteState !== "running") setConfirmDelete(false); }}
      />
    </DrawerShell>
  );
}

function OverviewRow({ icon: Icon, label, value, mono = false }: { icon: typeof FolderOpen; label: string; value: string; mono?: boolean }) {
  return <div className="grid grid-cols-[20px_90px_minmax(0,1fr)] items-center gap-2 border-b border-[var(--color-border)] px-3.5 py-2.5 last:border-0"><Icon className="h-4 w-4 text-[var(--color-text-muted)]" /><span className="text-xs text-[var(--color-text-muted)]">{label}</span><span className={`truncate text-sm text-[var(--color-text-secondary)] ${mono ? "font-mono text-xs" : ""}`} title={value}>{value}</span></div>;
}
