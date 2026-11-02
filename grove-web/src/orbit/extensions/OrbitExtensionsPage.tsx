import { useCallback, useEffect, useMemo, useState } from "react";
import { Blocks, FolderGit2, PackagePlus, Plus, Server } from "lucide-react";
import type { ExtensionArtifact } from "../../api/extensions";
import type { Plugin } from "../../api/plugins";
import { useProject } from "../../context";
import { useCommand } from "../../keyboard";
import { useExtensionsData } from "../../components/Skills/useExtensionsData";
import { useExtensionCatalog } from "../../components/Skills/useExtensionCatalog";
import { useMcpBuddyTargets } from "../../components/Skills/useMcpBuddyTargets";
import { AddSourceDialog } from "../../components/Skills/AddSourceDialog";
import { AddMcpDialog, McpManagementDrawer } from "../../components/Skills/McpManagement";
import { AddPluginDialog } from "../../components/Config/AddPluginDialog";
import { PluginDetailDialog } from "../../components/Config/PluginDetailDialog";
import { Button, OrbitPage, OrbitPageHeader, PopoverMenu, Segmented, useNow, type PageHue } from "../ui";
import { CatalogView } from "./CatalogView";
import { SourcesView } from "./SourcesView";
import { AgentsView } from "./AgentsView";
import type { DetailContext } from "./ExtensionDetail";
import "./orbit-extensions.css";

type ViewId = "catalog" | "sources" | "agents";

/** Relative "synced" times re-render on this cadence. */
const CLOCK_MS = 60_000;
/** Set by "Open in Extensions" on a chat's MCP warning. */
const WARNING_SEARCH_KEY = "grove:mcp-warning-search";

const HUE: PageHue = {
  from: "#a5b4fc",
  to: "#4338ca",
  strong: "rgb(67 56 202 / 75%)",
  glow: "color-mix(in oklab, #6366f1 13%, transparent)",
};

export function OrbitExtensionsPage() {
  const { selectedProject } = useProject();
  const projectPath = selectedProject?.path ?? null;
  const data = useExtensionsData();
  const catalog = useExtensionCatalog({ sources: data.sources, refreshToken: data.refreshToken });
  const buddies = useMcpBuddyTargets();
  const now = useNow(CLOCK_MS);
  const [view, setView] = useState<ViewId>("catalog");
  const [initialSearch] = useState(() => sessionStorage.getItem(WARNING_SEARCH_KEY) ?? "");
  useEffect(() => { sessionStorage.removeItem(WARNING_SEARCH_KEY); }, []);

  const [sourceDialog, setSourceDialog] = useState<"git" | "local" | null>(null);
  const [showAddPlugin, setShowAddPlugin] = useState(false);
  const [showAddMcp, setShowAddMcp] = useState(false);
  const [mcpSetup, setMcpSetup] = useState<ExtensionArtifact | null>(null);
  const [managedPlugin, setManagedPlugin] = useState<Plugin | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  // Catalog entry to open when arriving from a source's "Provides" list.
  const [catalogFocus, setCatalogFocus] = useState<string | null>(null);
  const [searchConsumed, setSearchConsumed] = useState(false);

  useCommand("skills.tab.explore", () => setView("catalog"), []);
  useCommand("skills.tab.sources", () => setView("sources"), []);
  useCommand("skills.tab.agents", () => setView("agents"), []);
  useCommand("skills.source.add", () => setSourceDialog("git"), []);

  const { reload, installPlugin } = catalog;
  const { refreshSources, refreshAfterInstall, refreshAgents, bumpCatalog } = data;
  const silentReload = useCallback(() => { void reload({ silent: true }); }, [reload]);
  const sourcesChanged = useCallback(async () => { await refreshSources(); bumpCatalog(); }, [refreshSources, bumpCatalog]);

  const context = useMemo<DetailContext>(() => ({
    enabledAgents: data.enabledAgents,
    agentOptions: catalog.agentOptions,
    buddies,
    installed: data.installed,
    projectPath,
    sourcesByName: catalog.sourcesByName,
    now,
    onCatalogChanged: silentReload,
    onSkillsChanged: refreshAfterInstall,
    onOpenMcpSetup: setMcpSetup,
    onManagePlugin: setManagedPlugin,
    onInstallPlugin: (item) => { void installPlugin(item); },
    installingKey: catalog.busyKey,
    revision: detailRevision,
  }), [detailRevision, buddies, catalog.agentOptions, catalog.busyKey, catalog.sourcesByName, data.enabledAgents, data.installed, installPlugin, now, projectPath, refreshAfterInstall, silentReload]);

  const enabledCount = data.enabledAgents.length;

  return (
    <OrbitPage
      className="oex"
      hue={HUE}
      overlays={(
        <>
          {/* Legacy dialogs, reused as they are. */}
          <AddSourceDialog isOpen={sourceDialog !== null} editingSource={null} initialSourceType={sourceDialog ?? "git"} onClose={() => setSourceDialog(null)} onSaved={async () => { setSourceDialog(null); await sourcesChanged(); }} />
          {showAddPlugin && <AddPluginDialog onClose={() => { setShowAddPlugin(false); bumpCatalog(); }} />}
          {showAddMcp && <AddMcpDialog projectPath={projectPath} onClose={() => { setShowAddMcp(false); void sourcesChanged(); }} onCreated={async () => { setShowAddMcp(false); await sourcesChanged(); }} />}
          {mcpSetup && <McpManagementDrawer artifact={mcpSetup} agents={catalog.agentOptions} projectPath={projectPath} onClose={() => { setMcpSetup(null); setDetailRevision((value) => value + 1); silentReload(); }} onSaved={silentReload} />}
          {managedPlugin && <PluginDetailDialog plugin={managedPlugin} onClose={() => { setManagedPlugin(null); setDetailRevision((value) => value + 1); silentReload(); }} onDeleted={async () => { setManagedPlugin(null); await refreshAfterInstall(); silentReload(); }} />}
        </>
      )}
    >
      <OrbitPageHeader
        raised
        icon={Blocks}
        title="Extensions"
        subtitle="What your agents can do: skills, plugins and MCP servers."
        actions={(
          <>
            <Segmented
              ariaLabel="View"
              value={view}
              onChange={(next) => { setView(next); setCatalogFocus(null); setSearchConsumed(true); }}
              options={[
                { value: "catalog", label: "Catalog", count: data.isLoading || catalog.loading ? undefined : catalog.records.length },
                { value: "sources", label: "Sources", count: data.isLoading ? undefined : data.sources.length },
                { value: "agents", label: "Agents", count: data.isLoading ? undefined : enabledCount },
              ]}
            />
            <PopoverMenu
              label="Add"
              items={[
                { id: "source", icon: FolderGit2, title: "Source", description: "Scan a Git repo or folder for skills and plugins", onSelect: () => setSourceDialog("git") },
                { id: "mcp", icon: Server, title: "MCP server", description: "Connect a local command or remote URL", onSelect: () => setShowAddMcp(true) },
                { id: "plugin", icon: PackagePlus, title: "Plugin", description: "Install a Grove plugin or load one in development", onSelect: () => setShowAddPlugin(true) },
              ]}
              trigger={({ open, toggle }) => (
                <Button variant="primary" aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Plus />Add</Button>
              )}
            />
          </>
        )}
      />

      {view === "catalog" ? (
        <CatalogView
          records={catalog.records}
          loading={catalog.loading}
          error={catalog.error}
          onRetry={() => void reload()}
          agents={data.agents}
          buddies={buddies}
          context={context}
          initialSearch={catalogFocus || searchConsumed ? "" : initialSearch}
          initialSelectedKey={catalogFocus}
          onAddSource={() => setSourceDialog("git")}
        />
      ) : view === "sources" ? (
        <SourcesView
          sources={data.sources}
          records={catalog.records}
          recordsLoading={catalog.loading}
          now={now}
          onRefresh={sourcesChanged}
          onAddSource={() => setSourceDialog("git")}
          onOpenRecord={(key) => { setCatalogFocus(key); setView("catalog"); }}
        />
      ) : (
        <AgentsView agents={data.agents} installed={data.installed} onRefresh={refreshAgents} />
      )}
    </OrbitPage>
  );
}
