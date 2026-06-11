/**
 * Agent Marketplace Modal — single window for browsing the ACP registry +
 * supplement, installing/uninstalling, and editing per-agent config.
 *
 * Two tabs:
 *   - Installed: auto-detected + grove-installed agents (the picker source)
 *   - Explore: everything in the registry not yet installed
 *
 * Detail panel slides in on the right when a card is clicked, showing the
 * Per-Agent Config Sheet (launch_mode toggle, args/env override, install
 * actions). Closing the detail returns to the grid.
 */

import { createElement, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

/** Renders an agent icon. Delegates to the central `agentIconComponent`,
 *  which applies the project-wide priority: bundled brand SVG  >  marketplace
 *  CDN icon  >  lucide Bot. The CDN map is populated by `setMarketplaceIcons`
 *  in the listMarketplace effect below, so every render site (chat list,
 *  Open Sessions, picker, this modal) renders the same icon for the same id. */
function AgentIcon({
  agent,
  size,
}: {
  agent: MarketplaceAgent;
  size: number;
}) {
  const Component = agentIconComponent(agent.id);
  return createElement(Component, { size });
}
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Search,
  RefreshCw,
  Loader2,
  CheckCircle2,
  Package,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import {
  listMarketplace,
  refreshRegistry,
  installAgent,
  uninstallAgent,
  patchAgent,
  type MarketplaceAgent,
  type MarketplaceResponse,
  type InstallMethod,
  type PatchAgentRequest,
} from "../../api/marketplace";
import {
  agentIconComponent,
  setMarketplaceIcons,
} from "../../utils/agentIcon";

interface MarketplaceModalProps {
  open: boolean;
  onClose: () => void;
}

type TabKind = "installed" | "explore";

function isInstalled(a: MarketplaceAgent): boolean {
  // "Installed tab" surfaces anything the user has *touched* — including
  // in-progress and failed installs. Without this, clicking Install would
  // appear to make the agent vanish (it flips to install_state=installing
  // and drops out of Explore but never shows up in Installed), and the
  // Retry CTA for a failed install would live in the wrong tab.
  return (
    a.install_state === "grove-installed" ||
    a.install_state === "auto-detected" ||
    a.install_state === "installing" ||
    a.install_state === "install-failed"
  );
}

/** Update available iff grove-installed (we know the precise version we put
 *  on disk) AND registry's published version differs from it. We compare as
 *  strings — semver-aware compare would be more polite, but the registry
 *  ships single-version-per-agent so any mismatch genuinely means "newer
 *  exists upstream". Auto-detected installs don't get update prompts because
 *  the version came from the user's own package manager, not us. */
function activeInstallation(a: MarketplaceAgent) {
  if (!a.installed) return null;
  const sel = a.installed.selected_install_method;
  return (
    a.installed.installations.find((i) => i.method === sel) ??
    a.installed.installations[0] ??
    null
  );
}

function hasUpdate(a: MarketplaceAgent): boolean {
  if (a.install_state !== "grove-installed") return false;
  const installed = activeInstallation(a)?.version;
  const latest = a.version;
  return Boolean(installed && latest && installed !== latest);
}

export function MarketplaceModal({ open, onClose }: MarketplaceModalProps) {
  const [data, setData] = useState<MarketplaceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<TabKind>("installed");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const resp = await listMarketplace();
      setData(resp);
      // Refresh the global icon CDN map so chat lists / pickers / Open
      // Sessions show registry icons for agents we don't have a bundled
      // brand SVG for. Util applies bundle > CDN > Bot priority.
      setMarketplaceIcons(resp.agents.map((a) => ({ id: a.id, icon_url: a.icon_url })));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    // Async reload — setState happens after `await`, not synchronously, so
    // this isn't the cascading-render pattern react-hooks/set-state-in-effect
    // flags. The lint can't tell the difference, hence the disable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [open]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const resp = await refreshRegistry();
      setData(resp);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const handleInstall = async (id: string, method: InstallMethod) => {
    setBusyId(id);
    try {
      await installAgent(id, method);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleUninstall = async (id: string, method: InstallMethod) => {
    setBusyId(id);
    try {
      await uninstallAgent(id, method);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handlePatch = async (id: string, body: PatchAgentRequest) => {
    setBusyId(id);
    try {
      await patchAgent(id, body);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    const tabFilter = (a: MarketplaceAgent) =>
      tab === "installed" ? isInstalled(a) : !isInstalled(a);
    const q = query.trim().toLowerCase();
    return data.agents.filter((a) => {
      if (!tabFilter(a)) return false;
      if (!q) return true;
      return (
        a.id.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      );
    });
  }, [data, tab, query]);

  const selected = useMemo(
    () => data?.agents.find((a) => a.id === selectedId) ?? null,
    [data, selectedId],
  );

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        className="relative flex h-full max-h-[820px] w-full max-w-[1100px] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-4">
          <Package className="h-5 w-5 text-[var(--color-highlight)]" />
          <div className="flex-1">
            <div className="text-base font-semibold text-[var(--color-text)]">
              Agent Marketplace
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              {data
                ? `${data.agents.length} agents · ${data.registry_stale ? "cached" : "fresh"}${
                    data.registry_fetched_at
                      ? ` · synced ${new Date(data.registry_fetched_at).toLocaleString()}`
                      : ""
                  }`
                : "Loading…"}
            </div>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-60"
            title="Refresh registry from CDN"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs + Search */}
        <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-5 py-3">
          <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5">
            {(["installed", "explore"] as TabKind[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  tab === t
                    ? "bg-[var(--color-highlight)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, id, or description…"
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] pl-9 pr-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 border-b border-[color-mix(in_srgb,var(--color-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_8%,transparent)] px-5 py-2 text-xs text-[var(--color-warning)]">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="ml-auto text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Body: grid + detail */}
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {loading && !data ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading marketplace…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
                {tab === "installed"
                  ? "No installed agents yet. Switch to Explore to browse."
                  : "No agents match your search."}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    selected={agent.id === selectedId}
                    onClick={() => setSelectedId(agent.id)}
                  />
                ))}
              </div>
            )}
          </div>

          <AnimatePresence mode="wait">
            {selected && (
              <motion.aside
                key={selected.id}
                initial={{ x: 24, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 24, opacity: 0 }}
                transition={{ duration: 0.14, ease: "easeOut" }}
                className="flex w-[420px] shrink-0 flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
              >
                <AgentDetail
                  agent={selected}
                  busy={busyId === selected.id}
                  onClose={() => setSelectedId(null)}
                  onInstall={(method) => handleInstall(selected.id, method)}
                  onUninstall={(method) => handleUninstall(selected.id, method)}
                  onPatch={(body) => handlePatch(selected.id, body)}
                />
              </motion.aside>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

interface CardProps {
  agent: MarketplaceAgent;
  selected: boolean;
  onClick: () => void;
}

function AgentCard({ agent, selected, onClick }: CardProps) {
  const stateLabel = installStateLabel(agent);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col gap-2 rounded-xl border bg-[var(--color-bg-secondary)] p-3 text-left transition-colors ${
        selected
          ? "border-[var(--color-highlight)]"
          : "border-[var(--color-border)] hover:border-[var(--color-highlight)]/60"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg)]">
          <AgentIcon agent={agent} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-[var(--color-text)]">
              {agent.name}
            </span>
            {hasUpdate(agent) && (
              <span
                title={`Update available: v${activeInstallation(agent)?.version} → v${agent.version}`}
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-highlight)]"
              />
            )}
          </div>
          <div className="text-[10px] text-[var(--color-text-muted)]">
            {agent.version ? `v${agent.version}` : "—"} · {stateLabel}
          </div>
        </div>
      </div>
      {agent.description && (
        <p className="line-clamp-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
          {agent.description}
        </p>
      )}
    </button>
  );
}

function installStateLabel(agent: MarketplaceAgent): string {
  switch (agent.install_state) {
    case "auto-detected":
      return "Detected on PATH";
    case "grove-installed": {
      const active = activeInstallation(agent);
      return `Installed via ${active?.method ?? "grove"}`;
    }
    case "installing":
      return "Installing…";
    case "install-failed":
      return "Install failed";
    case "not-installed":
    default:
      if (agent.available_install_methods.length === 0) return "Bring your own";
      return "Available";
  }
}

interface DetailProps {
  agent: MarketplaceAgent;
  busy: boolean;
  onClose: () => void;
  onInstall: (method: InstallMethod) => void;
  onUninstall: (method: InstallMethod) => void;
  onPatch: (body: PatchAgentRequest) => void;
}

function AgentDetail({ agent, busy, onClose, onInstall, onUninstall, onPatch }: DetailProps) {
  const installed = agent.installed;
  const availableMethods = agent.available_install_methods;
  const installedMethods = useMemo(
    () => new Set(installed?.installations.map((i) => i.method) ?? []),
    [installed],
  );
  const installableMethods = useMemo(
    () => availableMethods.filter((m) => !installedMethods.has(m)),
    [availableMethods, installedMethods],
  );

  const [argsDraft, setArgsDraft] = useState(
    (installed?.args_override ?? []).join(" "),
  );
  const [envDraft, setEnvDraft] = useState(
    Object.entries(installed?.env_override ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );

  useEffect(() => {
    // Reset local drafts when the parent swaps in a different installed
    // record (different agent or post-install refresh). The state lives
    // here so users can edit without committing — syncing on prop change
    // is exactly the case React docs flag with this lint, but we genuinely
    // want a "controlled mirror" of the server snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArgsDraft((installed?.args_override ?? []).join(" "));
    setEnvDraft(
      Object.entries(installed?.env_override ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
  }, [installed]);

  const parsedArgs = useMemo(
    () => argsDraft.split(/\s+/).filter(Boolean),
    [argsDraft],
  );
  const parsedEnv = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const line of envDraft.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
  }, [envDraft]);

  const canApply = isInstalled(agent);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-3 border-b border-[var(--color-border)] px-5 py-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg)]">
          <AgentIcon agent={agent} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[var(--color-text)]">
            {agent.name}
          </div>
          <div className="text-[11px] text-[var(--color-text-muted)]">
            {agent.id}
            {agent.version ? ` · v${agent.version}` : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4 text-sm">
        {agent.description && (
          <p className="leading-relaxed text-[var(--color-text)]">{agent.description}</p>
        )}

        <div className="space-y-1">
          <DetailRow label="State" value={installStateLabel(agent)} />
          {agent.binary && <BinaryRow binary={agent.binary} />}
          {agent.authors.length > 0 && (
            <DetailRow label="Authors" value={agent.authors.join(", ")} />
          )}
          {agent.license && <DetailRow label="License" value={agent.license} />}
        </div>

        {(agent.repository || agent.website) && (
          <div className="flex flex-wrap gap-3 text-xs">
            {agent.repository && (
              <a
                href={agent.repository}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[var(--color-highlight)] hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> Repository
              </a>
            )}
            {agent.website && (
              <a
                href={agent.website}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[var(--color-highlight)] hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> Website
              </a>
            )}
          </div>
        )}

        {/* Per-channel installation list. Each row shows a status badge,
            an "Active" indicator that doubles as a "Use this" radio
            (PATCHes selected_install_method), plus a per-channel
            Uninstall button. */}
        {installed && installed.installations.length > 0 && (
          <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              Installations
            </div>
            <div className="space-y-1.5">
              {installed.installations.map((inst) => {
                const isActive = inst.method === installed.selected_install_method;
                const isAuto = inst.method === "external";
                // Surface what the launch ACTUALLY is, not the storage
                // shorthand. External-channel agents that declare a terminal
                // launch contract spawn under a PTY (e.g. claude); the rest
                // spawn the PATH binary as a stdio ACP child.
                const methodLabel = isAuto
                  ? agent.supports_terminal_launch
                    ? "Terminal"
                    : "Local"
                  : inst.method;
                return (
                  <div
                    key={inst.method}
                    className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (isActive || inst.status !== "installed") return;
                        onPatch({ selected_install_method: inst.method });
                      }}
                      disabled={busy || inst.status !== "installed"}
                      title={isActive ? "Active channel" : "Use this channel"}
                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                        isActive
                          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]"
                          : "border-[var(--color-border)]"
                      } disabled:opacity-50`}
                    >
                      {isActive && (
                        <span className="block h-1.5 w-1.5 rounded-full bg-white" />
                      )}
                    </button>
                    <span
                      className="font-medium text-[var(--color-text)]"
                      title={inst.install_path ?? undefined}
                    >
                      {methodLabel}
                    </span>
                    {inst.version && (
                      <span className="text-[var(--color-text-muted)]">
                        v{inst.version}
                      </span>
                    )}
                    <InstallStatusBadge
                      status={inst.status}
                      labelOverride={
                        isAuto && inst.status === "installed"
                          ? "Auto Detected"
                          : undefined
                      }
                    />
                    {inst.failure_reason && (
                      <span
                        className="truncate text-[10px] text-[var(--color-warning)]"
                        title={inst.failure_reason}
                      >
                        {inst.failure_reason}
                      </span>
                    )}
                    {/* Auto-detected (External) channels: no Update /
                        Uninstall — managed by PATH presence. Remove the
                        binary from PATH to deregister; next scan drops it. */}
                    {!isAuto && (
                      <div className="ml-auto flex gap-1.5">
                        {hasUpdate(agent) && isActive && (
                          <button
                            type="button"
                            onClick={() => onInstall(inst.method)}
                            disabled={busy}
                            className="rounded-md border border-[var(--color-highlight)]/40 px-2 py-0.5 text-[10px] font-medium text-[var(--color-highlight)] hover:bg-[color-mix(in_srgb,var(--color-highlight)_10%,transparent)] disabled:opacity-60"
                            title={`Update v${inst.version} → v${agent.version}`}
                          >
                            Update
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onUninstall(inst.method)}
                          disabled={busy}
                          className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-warning)] hover:bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] disabled:opacity-60"
                        >
                          Uninstall
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Args / env override — only meaningful for grove-installed (we
            don't pipe these into auto-detected launches). */}
        {canApply && (
          <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                Extra args
              </label>
              <input
                type="text"
                value={argsDraft}
                onChange={(e) => setArgsDraft(e.target.value)}
                placeholder="--add-dir /tmp --foo bar"
                className="mt-1 h-8 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
              />
            </div>

            <div>
              <label className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                Env vars (KEY=value per line)
              </label>
              <textarea
                value={envDraft}
                onChange={(e) => setEnvDraft(e.target.value)}
                placeholder="ANTHROPIC_API_KEY=sk-..."
                rows={4}
                className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 font-mono text-[11px] text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
              />
            </div>

            {agent.install_state === "auto-detected" && (
              <p className="text-[10px] text-[var(--color-text-muted)]">
                Detected on PATH. Grove uses your existing install without touching it.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  onPatch({
                    args_override: parsedArgs,
                    env_override: parsedEnv,
                  })
                }
                disabled={busy}
                className="rounded-md bg-[var(--color-highlight)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
              >
                Apply
              </button>
            </div>
          </div>
        )}

        {/* Install actions — surfaced whenever there are channels the user
            hasn't installed yet. Visible both for fully-uninstalled agents
            and for already-installed agents that have additional channels
            available (the same agent may be installed via npx AND binary). */}
        {installableMethods.length > 0 && (
          <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              {installed ? "Add another channel" : "Install via"}
            </div>
            <div className="flex flex-wrap gap-2">
              {installableMethods.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => onInstall(m)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-highlight)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3 w-3" />
                  )}
                  Install ({m})
                </button>
              ))}
            </div>
          </div>
        )}

        {!installed && availableMethods.length === 0 && (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
            <ManualInstallHint agent={agent} />
          </div>
        )}
      </div>
    </div>
  );
}

function InstallStatusBadge({
  status,
  labelOverride,
}: {
  status: "installing" | "installed" | "failed";
  /** Override the label without changing colors — e.g. External rows
   *  display "Auto Detected" instead of "Installed" while keeping the
   *  same green badge styling. */
  labelOverride?: string;
}) {
  const cfg = (() => {
    switch (status) {
      case "installed":
        return {
          icon: <CheckCircle2 className="h-3 w-3" />,
          label: "Installed",
          cls: "text-[var(--color-success,#2e7d32)] border-[color-mix(in_srgb,var(--color-success,#2e7d32)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-success,#2e7d32)_10%,transparent)]",
        };
      case "installing":
        return {
          icon: <Loader2 className="h-3 w-3 animate-spin" />,
          label: "Installing",
          cls: "text-[var(--color-text-muted)] border-[var(--color-border)] bg-[var(--color-bg-secondary)]",
        };
      case "failed":
        return {
          icon: <AlertCircle className="h-3 w-3" />,
          label: "Failed",
          cls: "text-[var(--color-warning)] border-[color-mix(in_srgb,var(--color-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)]",
        };
    }
  })();
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${cfg.cls}`}
    >
      {cfg.icon}
      {labelOverride ?? cfg.label}
    </span>
  );
}

/** Renders manual install guidance for agents the registry doesn't ship a
 *  distribution for. Grove can still auto-detect the binary on PATH after
 *  the user installs it manually. */
function ManualInstallHint({ agent }: { agent: MarketplaceAgent }) {
  const repo = agent.repository;
  const website = agent.website;
  return (
    <div className="space-y-1.5 text-xs text-[var(--color-text-muted)]">
      <p>Install this agent's CLI on your PATH for grove to detect it.</p>
      {repo || website ? (
        <p>
          See{" "}
          {repo && (
            <a
              href={repo}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-highlight)] hover:underline"
            >
              repository
            </a>
          )}
          {repo && website ? " or " : ""}
          {website && (
            <a
              href={website}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-highlight)] hover:underline"
            >
              website
            </a>
          )}{" "}
          for install instructions, then hit <strong>Refresh</strong> to
          re-detect.
        </p>
      ) : (
        <p>After installing manually, hit <strong>Refresh</strong> to re-detect.</p>
      )}
    </div>
  );
}

function DetailRow({ label, value, tone }: { label: string; value: string; tone?: "warning" }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 text-xs">
      <div className="text-[var(--color-text-muted)]">{label}</div>
      <div
        className={
          tone === "warning"
            ? "text-[var(--color-warning)]"
            : "text-[var(--color-text)]"
        }
      >
        {value}
      </div>
    </div>
  );
}

function BinaryRow({ binary }: { binary: { command: string; path: string | null; version: string | null } }) {
  // Prefer the absolute path when we have one — its basename already conveys
  // the command, and the directory disambiguates shim layers in $PATH. Fall
  // back to the bare command when PATH lookup raced and lost the binary.
  const head = binary.path ?? binary.command;
  const display = binary.version ? `${head}  ${binary.version}` : head;
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 text-xs">
      <div className="text-[var(--color-text-muted)]">Binary</div>
      <div
        className="truncate font-mono text-[var(--color-text)]"
        title={display}
      >
        {display}
      </div>
    </div>
  );
}
