import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Check, Download, Globe, Loader2, RefreshCw, Settings2, TerminalSquare } from "lucide-react";
import type { AgentDef, InstalledSkill, SkillSource } from "../../api";
import type { ExtensionArtifact } from "../../api/extensions";
import type { InstalledAgentConfig } from "../../api/marketplace";
import type { Plugin } from "../../api/plugins";
import type { CatalogRecord } from "../../components/Skills/useExtensionCatalog";
import { connectionPresentation, type McpScope } from "../../components/Skills/mcpManagementState";
import { useMcpConnection } from "../../components/Skills/useMcpConnection";
import type { McpBuddyTarget } from "../../components/Skills/useMcpBuddyTargets";
import { pluginAttentionReasons } from "../../components/Skills/pluginAttention";
import { formatMode, sourceDisplayName } from "../../components/Skills/useSourceActions";
import { InstallDialog } from "../../components/Skills/InstallDialog";
import { MarkdownRenderer } from "../../components/ui";
import { useCommand } from "../../keyboard";
import { Button, DrawnCheck, Segmented, StatusDot, agoText, type StatusTone } from "../ui";
import { KIND_LABEL, attentionText, mcpEndpoint, primaryConnection, sinceText, versionText } from "./catalogModel";
import { AgentMark, ExtIcon, type MarkTarget } from "./parts";
import { useMcpAccess, type BindingRow } from "./useMcpAccess";
import { shortenPath } from "../../utils/path";
import { useProject } from "../../context";
import { parseAllowedTools, scopedInstallRecord, useSkillDetail } from "./useSkillDetail";
import { recordNeedsAttention } from "../../components/Skills/useExtensionCatalog";

export interface DetailContext {
  enabledAgents: AgentDef[];
  agentOptions: InstalledAgentConfig[];
  buddies: McpBuddyTarget[];
  installed: InstalledSkill[];
  projectPath: string | null;
  sourcesByName: Map<string, SkillSource>;
  now: number;
  /** Silent catalog refresh after an inline change. */
  onCatalogChanged: () => void;
  onSkillsChanged: () => Promise<void>;
  onOpenMcpSetup: (item: ExtensionArtifact) => void;
  onManagePlugin: (plugin: Plugin) => void;
  onInstallPlugin: (item: ExtensionArtifact) => void;
  installingKey: string | null;
  /** Bumped when a drawer or dialog may have changed the selection's state,
   *  so the pane remounts and re-reads it. */
  revision: number;
}

/** Detail pane for the selected catalog record. Keyed by the record so each
 *  selection mounts fresh (and its sections stagger in again). */
export function ExtensionDetail({ record, context }: { record: CatalogRecord; context: DetailContext }) {
  if (record.item.kind === "mcp") return <McpDetail record={record} context={context} />;
  if (record.item.kind === "skill") return <SkillDetailPane record={record} context={context} />;
  return <PluginDetailPane record={record} context={context} />;
}

function Ident({ record, kindLine }: { record: CatalogRecord; kindLine: string }) {
  const { item, plugin } = record;
  const version = versionText(item, plugin);
  return (
    <div className="oex-dsec oex-ident">
      <ExtIcon kind={item.kind} name={item.name} manifest={item.manifest} plugin={plugin} large />
      <div className="oex-ident-copy">
        <h2><span className="oui-truncate" title={item.name}>{plugin?.name || item.name}</span>{version ? <small>{version}</small> : null}</h2>
        <p className="oui-truncate" title={kindLine}>{kindLine}</p>
      </div>
    </div>
  );
}

function Alert({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="oex-alert" role="status">
      <AlertTriangle aria-hidden="true" />
      <div><b>{title}</b><span>{detail}</span></div>
      {action}
    </div>
  );
}

function OkLine({ children, off = false }: { children: ReactNode; off?: boolean }) {
  return <div className="oex-okline"><StatusDot tone={off ? "off" : "live"} ring={!off} />{children}</div>;
}

function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="oex-dsec">
      <div className="oex-shead"><h3>{title}</h3>{aside}</div>
      {children}
    </div>
  );
}

function SourceMeta({ item, context, extra }: { item: ExtensionArtifact; context: DetailContext; extra?: Array<[string, string]> }) {
  const source = context.sourcesByName.get(item.source);
  const cells: Array<[string, string]> = [
    ["Source", source ? sourceDisplayName(source) : item.source],
    ...(source ? [["Managed by", source.management_mode === "managed" ? "Grove" : formatMode(source.management_mode)], ["Synced", sinceText(source.last_synced, context.now)]] as Array<[string, string]> : []),
    ...(extra ?? []),
  ];
  return (
    <div className="oex-dsec">
      <div className="oex-meta" style={{ gridTemplateColumns: `repeat(${Math.min(cells.length, 3)}, minmax(0, 1fr))` }}>
        {cells.map(([label, value]) => (
          <div key={label}><span>{label}</span><b title={value}>{value}</b></div>
        ))}
      </div>
    </div>
  );
}

function Foot({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return <div className="oex-dfoot"><span className="oex-dfoot-note">{note}</span>{children}</div>;
}

function SavedNote({ count, text }: { count: number; text: string }) {
  if (count === 0) return null;
  return <span key={count} className="oex-saved" role="status"><DrawnCheck />{text}</span>;
}

/* ---------- MCP ---------- */

/** Connection check result → dot color. */
const RESULT_TONE: Record<string, StatusTone> = { success: "live", warning: "warn", danger: "fail", neutral: "off" };

const SCOPE_LABEL: Record<McpScope, string> = { global: "All projects", project: "This project", buddy: "Buddies" };

function McpDetail({ record, context }: { record: CatalogRecord; context: DetailContext }) {
  const { item } = record;
  const access = useMcpAccess({ artifact: item, projectPath: context.projectPath, onSaved: context.onCatalogChanged });
  const endpoint = mcpEndpoint(item);
  const connection = primaryConnection(item);
  const attention = recordNeedsAttention(record);
  const buddyScope = access.scope === "buddy";
  const targets: MarkTarget[] = buddyScope
    ? context.buddies.map((buddy) => ({ id: buddy.id, name: buddy.name, buddy: { buddyId: buddy.buddyId, avatar: buddy.avatar } }))
    : context.agentOptions.map((agent) => ({ id: agent.id, name: agent.name }));
  const scopes: McpScope[] = context.buddies.length ? ["global", "project", "buddy"] : ["global", "project"];
  const kindLine = `MCP server · ${endpoint?.kind === "remote" ? "remote URL" : endpoint ? "local command" : "no runtime"}`;
  const failing = connection && ["auth_required", "expired", "error"].includes(connection.status) ? connectionPresentation(connection) : null;

  return (
    <>
      <div className="oex-dbody oui-scroll">
        <Ident record={record} kindLine={kindLine} />
        {failing || attention || connection || item.description ? <div className="oex-dsec">
          {failing ? (
            <Alert title={failing.label} detail={failing.detail} action={<Button variant="primary" size="sm" onClick={() => context.onOpenMcpSetup(item)}>Open setup</Button>} />
          ) : attention ? (
            <Alert title="Not available to any agent yet" detail="Pick who can use it below. Agents get it on their next session." />
          ) : connection ? (
            <OkLine>{connectionPresentation(connection).label}{connection.checked_at ? ` · checked ${agoText(connection.checked_at * 1000, context.now)}` : ""}</OkLine>
          ) : null}
          {item.description ? <p className="oex-desc">{item.description}</p> : null}
        </div> : null}

        <Section
          title="Available to"
          aside={<Segmented size="sm" ariaLabel="Scope" value={access.scope} onChange={access.setScope} options={scopes.map((scope) => ({ value: scope, label: SCOPE_LABEL[scope], disabled: !access.loaded || (scope === "project" && !context.projectPath) }))} />}
        >
          {!access.loaded && !access.error ? (
            <div className="oex-agrid" aria-hidden="true">{[0, 1, 2].map((index) => <span key={index} className="oex-achip is-skel"><span className="oui-skel" /></span>)}</div>
          ) : targets.length === 0 ? (
            <p className="oex-hint">{buddyScope ? "No Buddies yet." : "Install an ACP agent before enabling this server."}</p>
          ) : (
            <div className="oex-agrid" key={access.scope}>
              {targets.map((target, index) => {
                const on = access.selected.includes(target.id);
                return (
                  <button
                    key={target.id}
                    type="button"
                    aria-pressed={on}
                    disabled={!access.loaded}
                    className={`oex-achip${on ? " is-on" : ""}`}
                    style={{ animationDelay: `${index * 25}ms` }}
                    onClick={() => access.toggle(target.id)}
                  >
                    <AgentMark target={target} size={22} />
                    <span className="oex-an">{target.name}</span>
                    <span className="oex-ck">{on ? <Check aria-hidden="true" /> : null}</span>
                  </button>
                );
              })}
            </div>
          )}
          {access.scope === "project" && context.projectPath && !isStudioPath(context.projectPath) ? <p className="oex-hint oui-mono oui-truncate" title={context.projectPath}>{context.projectPath}</p> : null}
          {access.loaded && access.elsewhere > 0 && !buddyScope ? <p className="oex-hint">Also on for {access.elsewhere} {access.elsewhere === 1 ? "agent" : "agents"} in other projects.</p> : null}
          {access.error ? (
            <p className="oex-err" role="alert">{access.error}{access.loaded ? null : <button type="button" className="oex-link" onClick={access.retry}>Retry</button>}</p>
          ) : null}
        </Section>

        {endpoint ? (
          <Section title="Connection">
            {endpoint.kind === "remote"
              ? <RemoteConnection key={endpoint.label} url={endpoint.label} headers={access.values} />
              : <div className="oex-conn"><TerminalSquare aria-hidden="true" /><span className="oui-mono oui-truncate" title={endpoint.label}>{endpoint.label}</span></div>}
          </Section>
        ) : null}

        <SourceMeta item={item} context={context} />

        {access.loaded ? <UsedBy rows={access.bindings} context={context} /> : null}
      </div>
      <Foot note={<SavedNote count={access.savedCount} text={buddyScope ? "Saved · Buddies pick it up when they next connect" : "Saved · agents pick it up on their next session"} />}>
        {access.saving ? <Loader2 className="oui-spin oex-foot-spin" aria-label="Saving" /> : null}
        <Button variant="secondary" size="sm" onClick={() => context.onOpenMcpSetup(item)}><Settings2 />Setup</Button>
      </Foot>
    </>
  );
}

/** Studio projects live at `studio://…`, an internal address nobody should read. */
function isStudioPath(path: string): boolean {
  return path.startsWith("studio://");
}

/** Another project in "Used by": its name, or its shortened path for a Coding project. */
function otherProjectLabel(path: string, projects: ReadonlyArray<{ path: string; name: string }>): string {
  const project = projects.find((item) => item.path === path);
  if (isStudioPath(path)) return project?.name ?? "A Studio project";
  return shortenPath(path);
}

/** Every agent / Buddy that has this server, and where: all scopes at once,
 *  so the scope switch above never hides a binding. */
function UsedBy({ rows, context }: { rows: BindingRow[]; context: DetailContext }) {
  const { projects } = useProject();
  const agents = new Map(context.agentOptions.map((agent) => [agent.id, agent.name]));
  const buddies = new Map(context.buddies.map((buddy) => [buddy.id, buddy]));
  return (
    <Section title="Used by">
      {rows.length === 0 ? (
        <p className="oex-hint">No agent or Buddy has this server yet.</p>
      ) : (
        <div className="oex-uses">
          {rows.map((row, index) => {
            const buddy = buddies.get(row.targetId);
            const target: MarkTarget = row.scope === "buddy"
              ? { id: row.targetId, name: buddy?.name ?? "Buddy", buddy: { buddyId: buddy?.buddyId ?? row.targetId.slice("buddy:".length), avatar: buddy?.avatar ?? null } }
              : { id: row.targetId, name: agents.get(row.targetId) ?? row.targetId };
            const where = row.scope === "global" ? "All projects"
              : row.scope === "buddy" ? "Buddy"
                : row.projectPath === context.projectPath ? "This project" : otherProjectLabel(row.projectPath ?? "", projects);
            return (
              <div key={`${row.scope}:${row.projectPath}:${row.targetId}`} className="oex-use" style={{ animationDelay: `${Math.min(index, 10) * 25}ms` }}>
                <AgentMark target={target} size={20} />
                <span className="oex-use-name oui-truncate">{target.name}</span>
                <span className={`oex-use-where oui-truncate${row.scope === "project" && row.projectPath !== context.projectPath && !isStudioPath(row.projectPath ?? "") ? " oui-mono" : ""}`} title={row.projectPath && !isStudioPath(row.projectPath) ? row.projectPath : undefined}>{where}</span>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/** Reads the saved connection on mount; Check re-probes the server. */
function RemoteConnection({ url, headers }: { url: string; headers: Record<string, string> }) {
  const controller = useMcpConnection({ url, headers });
  const [checked, setChecked] = useState(0);
  const checking = controller.phase === "checking";
  const presentation = connectionPresentation(controller.connection);
  const info = controller.connection?.server_info;
  return (
    <>
      <div className="oex-conn">
        <Globe aria-hidden="true" />
        <span className="oui-mono oui-truncate" title={url}>{url}</span>
        {checked > 0 && !checking && controller.connection ? (
          <span key={checked} className="oex-result"><StatusDot tone={RESULT_TONE[presentation.tone] ?? "live"} />{presentation.label}</span>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          disabled={controller.busy || controller.waiting}
          onClick={() => { void controller.check().then(() => setChecked((value) => value + 1)); }}
        >
          <RefreshCw className={checking ? "oui-spin" : undefined} />Check
        </Button>
      </div>
      {controller.error ? <p className="oex-err" role="alert">{controller.error}</p> : null}
      {info && (info.title || info.version || info.website_url) ? (
        <p className="oex-hint">
          Reports as <b>{info.title || info.name}</b>{info.version ? ` v${info.version}` : ""}
          {info.website_url ? <> · <a href={info.website_url} target="_blank" rel="noopener noreferrer">{info.website_url.replace(/^https?:\/\//, "")}</a></> : null}
        </p>
      ) : null}
    </>
  );
}

/* ---------- Skill ---------- */

function SkillDetailPane({ record, context }: { record: CatalogRecord; context: DetailContext }) {
  const { item } = record;
  const { detail, error, loading, reload } = useSkillDetail(item.source, item.name);
  const [installOpen, setInstallOpen] = useState(false);
  const scoped = useMemo(() => scopedInstallRecord(context.installed, item.repo_key, item.repo_path, context.projectPath), [context.installed, context.projectPath, item.repo_key, item.repo_path]);
  const installedIds = useMemo(() => new Set(scoped?.agents.map((binding) => binding.agent_id) ?? []), [scoped]);
  const installedCount = installedIds.size;
  const tools = detail?.metadata.allowed_tools ? parseAllowedTools(detail.metadata.allowed_tools) : [];
  const author = detail?.metadata.fields.author;
  const extraFields = Object.entries(detail?.metadata.fields ?? {}).filter(([key]) => key !== "author");

  const openInstall = () => { if (detail) setInstallOpen(true); };
  useCommand("skills.skill.install", openInstall, { enabled: () => !!detail && installedCount === 0 }, [detail, installedCount]);
  useCommand("skills.skill.uninstall", openInstall, { enabled: () => !!detail && installedCount > 0 }, [detail, installedCount]);

  return (
    <>
      <div className="oex-dbody oui-scroll">
        <Ident record={record} kindLine="Skill" />
        <div className="oex-dsec">
          {installedCount > 0
            ? <OkLine>Installed for {installedCount} {installedCount === 1 ? "agent" : "agents"}{scoped?.agents.some((binding) => binding.scope === "project") ? " · includes this project" : ""}</OkLine>
            : <OkLine off>Not installed</OkLine>}
          {(detail?.description || item.description) ? <p className="oex-desc">{detail?.description || item.description}</p> : null}
        </div>

        <Section
          title={<>Installed for · {installedCount} of {context.enabledAgents.length} agents</>}
          aside={<Button variant="ghost" size="sm" disabled={!detail} onClick={openInstall}>Manage</Button>}
        >
          {context.enabledAgents.length === 0 ? (
            <p className="oex-hint">Turn on an agent under Agents to install skills.</p>
          ) : (
            <div className="oex-agrid">
              {context.enabledAgents.map((agent, index) => {
                const on = installedIds.has(agent.id);
                return (
                  <span key={agent.id} className={`oex-achip is-static${on ? " is-on" : ""}`} style={{ animationDelay: `${index * 25}ms` }}>
                    <AgentMark target={{ id: agent.id, name: agent.display_name, iconId: agent.icon_id }} size={22} />
                    <span className="oex-an">{agent.display_name}</span>
                    <span className="oex-ck">{on ? <Check aria-hidden="true" /> : null}</span>
                  </span>
                );
              })}
            </div>
          )}
        </Section>

        {tools.length > 0 ? (
          <Section title="Allowed tools">
            <div className="oex-tools">{tools.map((tool, index) => <span key={tool} className="oex-tool oui-mono" style={{ animationDelay: `${index * 30}ms` }}>{tool}</span>)}</div>
          </Section>
        ) : null}

        <SourceMeta
          item={item}
          context={context}
          extra={[
            ...(author ? [["Author", author]] as Array<[string, string]> : []),
            ...(detail?.metadata.license ? [["License", detail.metadata.license]] as Array<[string, string]> : []),
            ...(detail?.metadata.compatibility ? [["Compatibility", detail.metadata.compatibility]] as Array<[string, string]> : []),
            ...extraFields,
          ]}
        />

        <Section title="SKILL.md">
          {loading ? (
            <div className="oex-md-skel" aria-hidden="true"><span className="oui-skel" /><span className="oui-skel" /><span className="oui-skel" /></div>
          ) : error ? (
            <p className="oex-err" role="alert">{error}<button type="button" className="oex-link" onClick={reload}>Retry</button></p>
          ) : detail?.skill_md_content ? (
            <div className="oex-md"><MarkdownRenderer content={detail.skill_md_content} /></div>
          ) : (
            <p className="oex-hint">This skill has no instructions beyond its description.</p>
          )}
        </Section>
      </div>
      <Foot note={item.relative_path ? <span className="oui-mono oui-truncate" title={item.relative_path}>{item.relative_path}</span> : null}>
        <Button variant={installedCount > 0 ? "secondary" : "primary"} size="sm" disabled={!detail} onClick={openInstall}>
          {installedCount > 0 ? <><Settings2 />Manage installs</> : <><Download />Install</>}
        </Button>
      </Foot>
      {detail ? (
        <InstallDialog
          isOpen={installOpen}
          skillName={detail.name}
          sourceName={detail.source}
          repoKey={detail.repo_key}
          repoPath={detail.repo_path}
          relativePath={detail.relative_path}
          agents={context.enabledAgents}
          installedRecord={scoped}
          projectPath={context.projectPath}
          onClose={() => setInstallOpen(false)}
          onInstalled={async () => { await context.onSkillsChanged(); context.onCatalogChanged(); reload(); }}
        />
      ) : null}
    </>
  );
}

/* ---------- Plugin ---------- */

const CONTRIBUTION_LABEL: Record<string, string> = {
  panel: "Workspace panel", sidebar: "Sidebar page", mcp: "MCP server", backend: "Backend", connectProviders: "Connect providers",
};

function pluginContributions(item: ExtensionArtifact, plugin?: Plugin): string[] {
  const declared = plugin?.contributes ?? (item.manifest?.contributes as Record<string, unknown> | undefined) ?? {};
  return Object.entries(declared).filter(([, value]) => !!value).map(([key]) => CONTRIBUTION_LABEL[key] ?? key);
}

function PluginDetailPane({ record, context }: { record: CatalogRecord; context: DetailContext }) {
  const { item, plugin } = record;
  const issues = pluginAttentionReasons(plugin);
  const contributions = pluginContributions(item, plugin);
  const permissions = plugin?.permissions ?? (Array.isArray(item.manifest?.permissions) ? (item.manifest.permissions as string[]) : []);
  const installing = context.installingKey === `${item.repo_key}/${item.repo_path}`;
  const origin = plugin ? (plugin.source === "dev" ? "Development" : plugin.source === "git" ? "Git" : "Local folder") : "Not installed";
  const extra: Array<[string, string]> = plugin
    ? [["Location", plugin.local_path], ["Updated", sinceText(plugin.updated_at, context.now)]]
    : item.repo_path ? [["Path", item.repo_path]] : [];

  return (
    <>
      <div className="oex-dbody oui-scroll">
        <Ident record={record} kindLine={`${KIND_LABEL.plugin} · ${origin}`} />
        <div className="oex-dsec">
          {issues.length > 0 ? (
            <Alert title={attentionText(record)} detail="Grove can’t load every part of this plugin until it’s fixed." action={plugin ? <Button variant="primary" size="sm" onClick={() => context.onManagePlugin(plugin)}>Open</Button> : undefined} />
          ) : plugin ? <OkLine>Installed{plugin.source === "dev" ? " · loaded from your folder" : ""}</OkLine> : <OkLine off>Available from {item.source}</OkLine>}
          {item.description ? <p className="oex-desc">{item.description}</p> : null}
        </div>
        <Section title="Adds">
          {contributions.length ? <div className="oex-tools">{contributions.map((label) => <span key={label} className="oex-tool">{label}</span>)}</div> : <p className="oex-hint">No contributions declared.</p>}
        </Section>
        <Section title="Permissions">
          {permissions.length ? <div className="oex-tools">{permissions.map((permission) => <span key={permission} className="oex-tool oui-mono">{permission}</span>)}</div> : <p className="oex-hint">No permissions requested.</p>}
        </Section>
        <SourceMeta item={item} context={context} extra={extra} />
      </div>
      <Foot>
        {plugin ? (
          <Button variant="secondary" size="sm" onClick={() => context.onManagePlugin(plugin)}><Settings2 />Manage</Button>
        ) : (
          <Button variant="primary" size="sm" disabled={installing} onClick={() => context.onInstallPlugin(item)}>
            {installing ? <Loader2 className="oui-spin" /> : <Download />}{installing ? "Installing…" : "Install plugin"}
          </Button>
        )}
      </Foot>
    </>
  );
}
