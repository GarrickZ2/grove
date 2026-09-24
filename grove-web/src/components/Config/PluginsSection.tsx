import { useCallback, useEffect, useState } from "react";
import { Download, FolderOpen, Puzzle, Trash2 } from "lucide-react";
import { Button } from "../ui";
import { listPlugins, deletePlugin, revealPluginFolder, type Plugin } from "../../api/plugins";
import { AddPluginDialog } from "./AddPluginDialog";
import { PluginDetailDialog } from "./PluginDetailDialog";
import { PluginIcon } from "../Plugins/PluginIcon";

/** Permissions that let a plugin modify files, run commands, or drive the agent
 *  — shown with a warning treatment so they don't sit flush with read-only ones.
 *  `exec` is the heaviest (spawned processes are unsandboxed ≈ full trust). */
const HIGH_RISK_PERMISSIONS = new Set(["exec", "project:write", "chat:read", "chat:write", "inject", "connect:provider", "prompt:middleware"]);

/** Human labels for declared permission strings; unknown perms fall back to the
 *  raw string so new backend permissions still render legibly. */
const PERMISSION_LABELS: Record<string, string> = {
  "chat:read": "Read chat & AI events",
  "chat:write": "Send prompts to the AI",
  "prompt:middleware": "Inspect, block, or modify prompts",
};

const permLabel = (perm: string): string => PERMISSION_LABELS[perm] ?? perm;

/**
 * Plugins management UI inside Settings: lists registered plugins (dev / local
 * / git), lets you Add one, Develop a new one, reveal its folder, or remove it.
 *
 * Plugins are *opened* where they actually live, not from here: a `panel`
 * plugin opens as a workspace FlexLayout panel (task `[+]` menu); a `sidebar`
 * plugin opens as a top-level page from the sidebar nav. Settings stays pure
 * management — it's app-scoped and can't host a task-scoped panel.
 */
export function PluginsSection() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [detailPlugin, setDetailPlugin] = useState<Plugin | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    listPlugins()
      .then(setPlugins)
      .catch(() => setPlugins([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    listPlugins()
      .then((ps) => {
        if (!cancelled) setPlugins(ps);
      })
      .catch(() => {
        if (!cancelled) setPlugins([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDelete = async (id: string) => {
    try {
      await deletePlugin(id);
    } finally {
      reload();
    }
  };

  return (
    <div className="space-y-4">
      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={() => setShowAdd(true)}>
          <Download className="mr-1.5 h-4 w-4" />
          Add Plugin
        </Button>
      </div>

      {/* List / empty / loading */}
      {loading ? (
        <div className="py-8 text-center text-xs text-[var(--color-text-muted)]">Loading…</div>
      ) : plugins.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--color-border)] py-10 text-center">
          <Puzzle className="h-6 w-6 text-[var(--color-text-muted)]" />
          <div className="text-sm font-medium text-[var(--color-text)]">No plugins yet</div>
          <div className="max-w-xs text-xs text-[var(--color-text-muted)]">
            Add one from a local folder or GitHub, or develop your own.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {plugins.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2.5"
            >
              <button
                type="button"
                onClick={() => setDetailPlugin(p)}
                title="View plugin details"
                className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left transition-colors hover:bg-[var(--color-bg)]/40"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--color-highlight)]/10">
                  <PluginIcon plugin={p} className="h-4 w-4 text-[var(--color-highlight)]" size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-[var(--color-text)]">
                    {p.name}
                  </span>
                  <span className="shrink-0 rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                    v{p.version}
                  </span>
                  {p.source === "dev" && (
                    <span className="shrink-0 rounded-full bg-[var(--color-highlight)]/10 px-1.5 py-0.5 text-[10px] text-[var(--color-highlight)]">
                      dev
                    </span>
                  )}
                  {p.exists === false ? (
                    <span
                      className="shrink-0 rounded-full bg-[var(--color-error)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-error)]"
                      title="The plugin's folder no longer exists on disk. Delete this entry to clean it up."
                    >
                      ⚠ missing
                    </span>
                  ) : (
                    p.unbuilt &&
                    p.unbuilt.length > 0 && (
                      <span
                        className="shrink-0 rounded-full bg-[var(--color-warning)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-warning)]"
                        title={`Not built: ${p.unbuilt.join(", ")} — run \`npm run build\` in the plugin folder, then Reload.`}
                      >
                        ⚠ not built: {p.unbuilt.join(", ")}
                      </span>
                    )
                  )}
                  {p.contributes?.panel && (
                    <span
                      className="shrink-0 rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                      title="Opens as a workspace panel — from a task's toolbar (IDE Layout) or [+] menu (Free Layout)"
                    >
                      panel
                    </span>
                  )}
                  {p.contributes?.sidebar && (
                    <span
                      className="shrink-0 rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                      title="Opens as a top-level page — from the sidebar"
                    >
                      sidebar
                    </span>
                  )}
                  {p.permissions?.map((perm) => {
                    const highRisk = HIGH_RISK_PERMISSIONS.has(perm);
                    return (
                      <span
                        key={perm}
                        className={
                          highRisk
                            ? "shrink-0 rounded-full bg-[var(--color-warning)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-warning)]"
                            : "shrink-0 rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                        }
                        title={
                          highRisk
                            ? "High-risk permission — this plugin can modify your files, run commands, or drive the agent"
                            : "Declared permission"
                        }
                      >
                        {highRisk ? `⚠ ${permLabel(perm)}` : permLabel(perm)}
                      </span>
                    );
                  })}
                </div>
                  <div className="truncate text-xs text-[var(--color-text-muted)]">
                    {p.local_path}
                  </div>
                  {p.runtime && !p.runtime.available && (
                    <div className="truncate text-xs text-[var(--color-warning)]">
                      Needs “{p.runtime.command}” on PATH for its MCP tools
                    </div>
                  )}
                </div>
              </button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void revealPluginFolder(p.id).catch(() => {});
                }}
                title="Reveal folder in Finder"
              >
                <FolderOpen className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void handleDelete(p.id);
                }}
                title={p.source === "dev" ? "Remove from list" : "Uninstall (deletes files)"}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <AddPluginDialog
          onClose={() => {
            setShowAdd(false);
            reload();
          }}
        />
      )}
      {detailPlugin && (
        <PluginDetailDialog plugin={detailPlugin} onClose={() => setDetailPlugin(null)} onDeleted={reload} />
      )}
    </div>
  );
}
