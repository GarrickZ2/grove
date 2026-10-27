import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, X } from "lucide-react";
import { Button, Combobox, DialogShell, DrawerShell } from "../ui";
import { ConfirmDialog } from "../Dialogs/ConfirmDialog";
import {
  createManagedMcp,
  installMcp,
  type ManagedMcpServer,
  type ExtensionArtifact,
  type McpConnection,
  type McpServerInfo,
} from "../../api/extensions";
import {
  listInstalledAgentConfigs,
  type InstalledAgentConfig,
} from "../../api/marketplace";
import {
  McpAgentAccess,
  type McpAccessOptions,
  type McpAccessDraft,
} from "./McpAgentAccess";
import { ExtensionIdentityIcon } from "./ExtensionIdentityIcon";
import { AgentIcon } from "./AgentIcon";
import {
  McpAuthFields,
  McpConnectionSection,
  McpConnectionStatus,
  McpDisclosure,
  McpFeedback,
  McpSignInWaiting,
  mcpIconButtonClass,
  mcpInputClass,
} from "./McpConnectionViews";
import {
  useMcpConnection,
  mcpErrorText,
  type McpAuthOptions,
} from "./useMcpConnection";
import { useMcpBindings } from "./useMcpBindings";
import { useMcpDialogFocus } from "./useMcpDialogFocus";
import { requiresMcpAuthorization } from "./mcpManagementState";
import {
  Footer,
  McpSetupCredentials,
  VariableDefinitions,
} from "./McpSetupFields";
import {
  definitions,
  type SetupProps,
  type Variable,
  type Runtime,
  type Definition,
} from "./mcpSetupTypes";
import { PackageAddForm, PackageManagedConnection } from "./McpPackageSetup";

const schema =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
function runtimeLabel(runtime: Runtime) {
  return { remote: "Remote HTTP", npm: "NPM", pypi: "PyPI", oci: "OCI" }[
    runtime
  ];
}

export function AddMcpDialog({
  onClose,
  onCreated,
  projectPath = null,
}: {
  onClose: () => void;
  onCreated: () => void | Promise<void>;
  projectPath?: string | null;
}) {
  const [runtime, setRuntime] = useState<Runtime>("remote");
  const [remoteSetupActive, setRemoteSetupActive] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const created = useRef<ManagedMcpServer | null>(null);
  const [definitionLocked, setDefinitionLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [agents, setAgents] = useState<InstalledAgentConfig[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [accessDraft, setAccessDraft] = useState<McpAccessDraft>({
    scope: projectPath ? "project" : "global",
    agentIds: [],
  });
  const [completed, setCompleted] = useState<{
    name: string;
    agents: InstalledAgentConfig[];
    scope: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void listInstalledAgentConfigs()
      .then((items) => {
        if (active) {
          setAgents(items);
          setAgentError(null);
          setLoadingAgents(false);
        }
      })
      .catch((cause) => {
        if (active) {
          setAgentError(mcpErrorText(cause));
          setLoadingAgents(false);
        }
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const close = () => {
    if (!saving) onClose();
  };
  useMcpDialogFocus(root, close);
  const access: McpAccessOptions = {
    draft: accessDraft,
    onChange: setAccessDraft,
    agents,
    projectPath,
    loading: loadingAgents,
    error: agentError,
    disabled: saving,
    onRetry: () => {
      setLoadingAgents(true);
      setAgentError(null);
      setRevision((value) => value + 1);
    },
  };
  const onCreate: SetupProps["onCreate"] = async (manifest, values) => {
    if (!accessDraft.agentIds.length || loadingAgents || agentError) return;
    if (!created.current) {
      created.current = await createManagedMcp(manifest);
      setDefinitionLocked(true);
    }
    try {
      await installMcp({
        repo_key: created.current.repo_key,
        repo_path: created.current.repo_path,
        scope: accessDraft.scope,
        project_path:
          accessDraft.scope === "project"
            ? (projectPath ?? undefined)
            : undefined,
        agent_ids: accessDraft.agentIds,
        runtime: {
          kind: runtime === "remote" ? "remote" : "package",
          index: 0,
        },
        values,
      });
    } catch (cause) {
      throw new Error(
        `Server saved, but Agent access could not be enabled. Retry to finish setup. ${mcpErrorText(cause)}`,
      );
    }
    setCompleted({
      name: String(manifest.name),
      scope: accessDraft.scope,
      agents: agents.filter((agent) => accessDraft.agentIds.includes(agent.id)),
    });
  };
  const setup: SetupProps = { access, onCreate, definitionLocked };
  return (
    <DialogShell isOpen onClose={close} maxWidth="max-w-[620px]">
      <div
        ref={root}
        className="flex max-h-[min(88dvh,760px)] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--color-border)] px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold">
              {completed ? "MCP Server added" : "Add MCP Server"}
            </h2>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              {completed
                ? "Server and Agent access have been saved."
                : "Connect a server, then choose where your Agents can use it."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            className={mcpIconButtonClass}
            onClick={close}
            disabled={saving}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {completed ? (
          <>
            <div
              className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5"
              role="status"
            >
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-success)]" />
                <div>
                  <h3 className="text-base font-semibold">{completed.name}</h3>
                  <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                    Configured for {completed.agents.length}{" "}
                    {completed.agents.length === 1 ? "Agent" : "Agents"}.
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium">Available in</p>
                <p className="mt-2 break-all text-sm">
                  {completed.scope === "global" ? "All projects" : projectPath}
                </p>
              </div>
              <div className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)]">
                {completed.agents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <AgentIcon iconId={agent.id} size={18} />
                    <span className="text-sm">{agent.name}</span>
                    <CheckCircle2 className="ml-auto h-4 w-4 text-[var(--color-success)]" />
                  </div>
                ))}
              </div>
              <p className="text-xs leading-5 text-[var(--color-text-muted)]">
                Takes effect when an Agent next connects. Start a new session or
                reconnect an existing Agent to use this server.
              </p>
            </div>
            <footer className="flex shrink-0 justify-end border-t border-[var(--color-border)] px-6 py-4">
              <Button onClick={() => void onCreated()}>Done</Button>
            </footer>
          </>
        ) : (
          <>
            {!remoteSetupActive && (
              <div className="shrink-0 px-6 pt-5">
                <div
                  className="flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 p-1"
                  aria-label="Server runtime"
                >
                  {(["remote", "npm", "pypi", "oci"] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={runtime === type}
                      disabled={saving || definitionLocked}
                      onClick={() => setRuntime(type)}
                      className={`min-w-0 flex-1 rounded-md px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-highlight)] disabled:opacity-50 ${runtime === type ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
                    >
                      {runtimeLabel(type)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(["remote", "npm", "pypi", "oci"] as const).map((type) => (
              <div
                key={type}
                className={
                  runtime === type ? "flex min-h-0 flex-1 flex-col" : "hidden"
                }
              >
                {type === "remote" ? (
                  <RemoteAddForm
                    onSetupChange={setRemoteSetupActive}
                    onClose={close}
                    onSaving={setSaving}
                    {...setup}
                  />
                ) : (
                  <PackageAddForm
                    onSetupChange={setRemoteSetupActive}
                    runtime={type}
                    onClose={close}
                    onSaving={setSaving}
                    {...setup}
                  />
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </DialogShell>
  );
}

function RemoteAddForm({
  onSetupChange,
  onClose,
  access,
  onCreate,
  definitionLocked,
  onSaving,
}: {
  onSetupChange: (active: boolean) => void;
  onClose: () => void;
  onSaving: (value: boolean) => void;
} & SetupProps) {
  const [url, setUrl] = useState("");
  const [activeUrl, setActiveUrl] = useState("");
  const connect = () => {
    if (!url.trim()) return;
    setActiveUrl(url.trim());
    onSetupChange(true);
  };
  if (activeUrl)
    return (
      <RemoteSetup
        key={activeUrl}
        url={activeUrl}
        onChangeUrl={() => {
          setActiveUrl("");
          onSetupChange(false);
        }}
        onClose={onClose}
        access={access}
        onCreate={onCreate}
        definitionLocked={definitionLocked}
        onSaving={onSaving}
      />
    );
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        connect();
      }}
    >
      <div className="space-y-4 px-6 py-5">
        <label className="block text-xs font-medium">
          Server URL
          <input
            id="mcp-location"
            data-autofocus
            autoFocus
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className={mcpInputClass}
            placeholder="https://example.com/mcp"
            autoComplete="url"
          />
        </label>
        <p className="text-xs leading-5 text-[var(--color-text-muted)]">
          Grove will read the server’s details and guide you through sign-in if
          needed.
        </p>
      </div>
      <Footer onClose={onClose} label="Connect" disabled={!url.trim()} />
    </form>
  );
}

function RemoteSetup({
  url,
  onChangeUrl,
  onClose,
  access,
  onCreate,
  definitionLocked,
  onSaving,
}: {
  url: string;
  onChangeUrl: () => void;
  onClose: () => void;
  onSaving: (value: boolean) => void;
} & SetupProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [variables, setVariables] = useState<Variable[]>([]);
  const [credentialValues, setCredentialValues] = useState<
    Record<string, string>
  >({});
  const [options, setOptions] = useState<McpAuthOptions>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headerValues = Object.fromEntries(
    definitions(variables).flatMap((field) =>
      credentialValues[field.name] === undefined
        ? []
        : [[field.name, credentialValues[field.name]]],
    ),
  );
  const controller = useMcpConnection({
    url,
    headers: headerValues,
    autoCheck: true,
  });
  const info = controller.connection?.server_info;
  const connected =
    controller.connection?.status === "authorized" ||
    controller.connection?.status === "public";
  const finalName =
    name.trim() ||
    info?.title ||
    info?.name ||
    (connected ? new URL(url).hostname : "");
  const oauth = controller.connection?.auth_type === "oauth";
  const mustAuthorize = requiresMcpAuthorization(controller.connection);
  const canConfigure =
    connected &&
    !!finalName &&
    !mustAuthorize &&
    !controller.waiting &&
    !controller.busy;
  const accessReady =
    access.draft.agentIds.length > 0 &&
    !access.loading &&
    !access.error &&
    definitions(variables).every(
      (field) => !field.isRequired || credentialValues[field.name]?.trim(),
    );
  const canSave = canConfigure && accessReady;
  const create = async () => {
    if (!canSave) return;
    setSaving(true);
    onSaving(true);
    setError(null);
    try {
      await onCreate(
        {
          $schema: schema,
          name: finalName,
          description: description.trim() || info?.description || "",
          version: info?.version || "unknown",
          ...(info?.icons.length ? { icons: info.icons } : {}),
          ...(info?.website_url ? { websiteUrl: info.website_url } : {}),
          remotes: [
            {
              type: "streamable-http",
              url,
              ...(variables.length ? { headers: definitions(variables) } : {}),
            },
          ],
        },
        Object.fromEntries(
          definitions(variables).flatMap((field) =>
            credentialValues[field.name] === undefined
              ? []
              : [[field.name, credentialValues[field.name]]],
          ),
        ),
      );
    } catch (cause) {
      setError(mcpErrorText(cause));
    } finally {
      setSaving(false);
      onSaving(false);
    }
  };
  const action = mustAuthorize
    ? () => void controller.authorize(options)
    : canConfigure
      ? () => void create()
      : () => void controller.check();
  const label = saving
    ? "Adding…"
    : controller.waiting
      ? "Waiting for sign-in…"
      : controller.busy
        ? "Connecting…"
        : mustAuthorize
          ? "Authorize & continue"
          : canConfigure
            ? definitionLocked
              ? "Retry enabling"
              : "Add & enable"
            : "Retry connection";
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!controller.busy && !controller.waiting && !saving) action();
      }}
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
        <div className="flex items-start gap-3">
          {connected && (
            <ExtensionIdentityIcon
              kind="mcp"
              name={info?.title || info?.name || finalName}
              manifest={{ icons: info?.icons ?? [] }}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p
                  className={
                    connected
                      ? "text-base font-semibold"
                      : "text-xs font-medium"
                  }
                >
                  {connected
                    ? info?.title || info?.name || finalName
                    : "Server URL"}
                </p>
                {connected && info?.version && (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    v{info.version}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={onChangeUrl}
                disabled={saving || definitionLocked}
                className="rounded text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-highlight)]"
              >
                Change
              </button>
            </div>
            <p
              className={`mt-2 break-all font-mono text-xs leading-5 text-[var(--color-text-muted)] ${connected ? "" : "rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-3 py-2.5"}`}
            >
              {url}
            </p>
            {connected && info?.description && (
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--color-text-muted)]">
                {info.description}
              </p>
            )}
          </div>
        </div>
        {controller.waiting ? (
          <McpSignInWaiting controller={controller} />
        ) : connected && !controller.busy ? (
          <p
            role="status"
            className="flex items-center gap-2 text-xs text-[var(--color-success)]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            {oauth
              ? "Connection verified · Authorization saved in Grove"
              : "Connection verified"}
          </p>
        ) : (
          <McpConnectionStatus controller={controller} />
        )}
        <McpFeedback
          error={error || controller.error || controller.connection?.error}
        />
        {canConfigure && (
          <div className="border-t border-[var(--color-border)] pt-5">
            <McpAgentAccess {...access} />
            <McpSetupCredentials
              variables={variables}
              values={credentialValues}
              onChange={setCredentialValues}
              disabled={saving}
            />
          </div>
        )}
        {!controller.waiting && (
          <McpDisclosure
            title={
              info || connected ? "Edit display details" : "Set up manually"
            }
          >
            <fieldset
              disabled={saving || definitionLocked}
              className="space-y-3"
            >
              <label className="block text-xs font-medium">
                Display name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={info?.title || info?.name || "Server name"}
                  className={mcpInputClass}
                />
              </label>
              <label className="block text-xs font-medium">
                Description
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={info?.description || "Optional"}
                  className={mcpInputClass}
                />
              </label>
              <VariableDefinitions
                variables={variables}
                onChange={setVariables}
                remote
              />
            </fieldset>
          </McpDisclosure>
        )}
        {!canConfigure && !controller.waiting && (
          <McpSetupCredentials
            variables={variables}
            values={credentialValues}
            onChange={setCredentialValues}
            disabled={saving || controller.busy}
          />
        )}
        {oauth && !controller.waiting && (
          <McpDisclosure title="Advanced authentication">
            <McpAuthFields options={options} onChange={setOptions} />
          </McpDisclosure>
        )}
      </div>
      <Footer
        onClose={onClose}
        label={label}
        busy={saving}
        disabled={
          controller.busy ||
          controller.waiting ||
          (canConfigure && !accessReady)
        }
        hint={
          canConfigure && !access.draft.agentIds.length
            ? "Choose at least one Agent"
            : undefined
        }
      />
    </form>
  );
}

export function McpManagementDrawer({
  artifact,
  agents,
  projectPath,
  onClose,
  onSaved,
}: {
  artifact: ExtensionArtifact;
  agents: InstalledAgentConfig[];
  projectPath: string | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<McpConnection | null>(null);
  const [packageInfo, setPackageInfo] = useState<McpServerInfo | null>(null);
  const [valuesRevision, setValuesRevision] = useState(0);
  const [confirmation, setConfirmation] = useState<
    | { type: "discard" }
    | { type: "disconnect"; action: () => Promise<void> }
    | null
  >(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const manifest = artifact.manifest ?? {};
  const remotes = Array.isArray(manifest.remotes)
    ? (manifest.remotes as Definition[])
    : [];
  const packages = Array.isArray(manifest.packages)
    ? (manifest.packages as Definition[])
    : [];
  const variants = [
    ...remotes.map((value, index) => ({
      kind: "remote" as const,
      index,
      value,
      label: String(value.url ?? "Remote HTTP"),
    })),
    ...packages.map((value, index) => ({
      kind: "package" as const,
      index,
      value,
      label: `${String(value.registryType ?? "Package")} · ${String(value.identifier ?? "")}`,
    })),
  ];
  const editor = useMcpBindings({
    repoKey: artifact.repo_key,
    repoPath: artifact.repo_path,
    projectPath,
    hasRemotes: remotes.length > 0,
  });
  const runtime = editor.draft?.runtime ?? variants[0];
  const variant = variants.find(
    (item) => item.kind === runtime?.kind && item.index === runtime?.index,
  );
  const fieldDefinitions =
    variant?.kind === "remote"
      ? variant.value.headers
      : variant?.value.environmentVariables;
  const fields = Array.isArray(fieldDefinitions)
    ? (fieldDefinitions as Definition[])
    : [];
  const detectedInfo = connection?.server_info ?? packageInfo;
  const version =
    detectedInfo?.version ||
    (artifact.version !== "unknown" ? artifact.version : null);
  const requestClose = () => {
    if (confirmation || editor.saving) return;
    if (editor.dirtyScopes.length) setConfirmation({ type: "discard" });
    else onClose();
  };
  useMcpDialogFocus(root, requestClose, confirmation !== null, () => {
    if (!confirmBusy) setConfirmation(null);
  });
  const save = async () => {
    if (await editor.save(fields)) await onSaved();
  };
  return (
    <DrawerShell
      isOpen
      onClose={requestClose}
      width="w-full sm:w-[620px] max-sm:max-w-full"
    >
      <div
        ref={root}
        className="flex h-full min-h-0 flex-col bg-[var(--color-bg)] text-[var(--color-text)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--color-border)] px-6 py-5">
          <div className="flex min-w-0 items-center gap-3.5">
            <ExtensionIdentityIcon
              kind="mcp"
              name={artifact.name}
              manifest={
                detectedInfo?.icons.length
                  ? { ...manifest, icons: detectedInfo.icons }
                  : manifest
              }
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h2 className="break-words text-lg font-semibold">
                  {artifact.name}
                </h2>
                {version && (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    v{version}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                MCP Server
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            className={mcpIconButtonClass}
            onClick={requestClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {(detectedInfo?.description || artifact.description) && (
            <p className="text-sm leading-6 text-[var(--color-text-muted)]">
              {detectedInfo?.description || artifact.description}
            </p>
          )}
          {variants.length > 1 && editor.draft && (
            <div>
              <label className="mb-2 block text-xs font-medium">Runtime</label>
              <Combobox
                allowCustom={false}
                value={`${runtime?.kind}-${runtime?.index}`}
                onChange={(value) => {
                  const next = variants.find(
                    (item) => `${item.kind}-${item.index}` === value,
                  );
                  if (next) {
                    editor.updateDraft({
                      runtime: { kind: next.kind, index: next.index },
                    });
                    setConnection(null);
                    setPackageInfo(null);
                  }
                }}
                options={variants.map((item) => ({
                  id: `${item.kind}-${item.index}`,
                  value: `${item.kind}-${item.index}`,
                  label: item.label,
                }))}
              />
            </div>
          )}
          {variant?.kind === "remote" ? (
            <RemoteManagedConnection
              key={String(variant.value.url)}
              url={String(variant.value.url)}
              headers={Object.fromEntries(
                fields.flatMap((field) => {
                  const name = String(field.name);
                  const value = editor.draft?.values[name];
                  return value === undefined ? [] : [[name, value]];
                }),
              )}
              onChange={setConnection}
              onDisconnect={(action) =>
                setConfirmation({ type: "disconnect", action })
              }
            />
          ) : (
            variant && (
              <PackageManagedConnection
                key={`${variant.index}-${editor.scope}-${valuesRevision}`}
                packageDefinition={variant.value}
                values={editor.draft?.values ?? {}}
                onChange={setPackageInfo}
              />
            )
          )}
          <section
            className="space-y-3 border-t border-[var(--color-border)] pt-5"
            aria-label="Agent configuration"
          >
            {editor.loaded && editor.savedAgentCount === 0 && (
              <p
                role="status"
                className="rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 px-4 py-3 text-xs leading-5 text-[var(--color-warning)]"
              >
                Not available to any Agent yet. Choose a scope and at least one
                Agent below, then save.
              </p>
            )}
            <McpAgentAccess
              draft={{
                scope: editor.scope,
                agentIds: editor.draft?.agentIds ?? [],
              }}
              onChange={(next) => {
                if (next.scope !== editor.scope) editor.setScope(next.scope);
                else editor.updateDraft({ agentIds: next.agentIds });
              }}
              agents={agents}
              projectPath={projectPath}
              loading={!editor.loaded && !editor.error}
              error={!editor.loaded ? editor.error : null}
              onRetry={editor.retry}
              disabled={editor.saving || !editor.loaded}
              dirtyScopes={editor.dirtyScopes}
            />
            {fields.map((field) => (
              <label
                key={String(field.name)}
                className="block text-xs font-medium"
              >
                {String(field.name)}
                {field.isRequired === true && " *"}
                <input
                  aria-label={String(field.name)}
                  type={field.isSecret === true ? "password" : "text"}
                  autoComplete="off"
                  className={mcpInputClass}
                  disabled={!editor.loaded || editor.saving}
                  value={editor.draft?.values[String(field.name)] ?? ""}
                  onChange={(event) => {
                    setValuesRevision((value) => value + 1);
                    editor.updateDraft({
                      values: {
                        ...editor.draft?.values,
                        [String(field.name)]: event.target.value,
                      },
                    });
                  }}
                />
              </label>
            ))}
            <McpFeedback
              error={editor.loaded ? editor.error : null}
              notice={editor.notice}
            />
          </section>
          <div className="border-t border-[var(--color-border)] pt-4">
            <McpDisclosure title="Server details">
              <dl className="space-y-3 text-xs">
                <Detail label="Source" value={artifact.source} />
                <Detail
                  label="Manifest"
                  value={artifact.relative_path || "server.json"}
                />
                {detectedInfo?.name && (
                  <Detail label="Server identity" value={detectedInfo.name} />
                )}
              </dl>
            </McpDisclosure>
          </div>
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]/35 px-6 py-4">
          {editor.dirtyScopes.length > 0 && (
            <span className="mr-auto text-xs text-[var(--color-text-muted)]">
              Unsaved changes
            </span>
          )}
          <Button
            variant="secondary"
            disabled={editor.saving}
            onClick={requestClose}
          >
            Done
          </Button>
          <Button
            disabled={
              !editor.loaded || !editor.dirty || editor.saving || !variant
            }
            onClick={() => void save()}
          >
            {editor.saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editor.saving ? "Saving…" : "Save changes"}
          </Button>
        </footer>
      </div>
      <ConfirmDialog
        isOpen={confirmation !== null}
        title={
          confirmation?.type === "disconnect"
            ? "Cancel authorization?"
            : "Discard unsaved changes?"
        }
        message={
          confirmation?.type === "disconnect"
            ? "Grove will remove its saved credentials and request revocation when supported. This server and its Agent bindings will stay. Running Agents may keep their current token until it expires."
            : "Your unsaved Agent bindings and credential edits will be discarded. Saved authorization will stay."
        }
        confirmLabel={
          confirmBusy
            ? "Cancelling…"
            : confirmation?.type === "disconnect"
              ? "Cancel authorization"
              : "Discard changes"
        }
        cancelLabel={
          confirmation?.type === "disconnect"
            ? "Keep authorization"
            : "Keep editing"
        }
        variant="danger"
        actionsDisabled={confirmBusy}
        onCancel={() => {
          if (!confirmBusy) setConfirmation(null);
        }}
        onConfirm={() => {
          if (confirmation?.type === "discard") {
            setConfirmation(null);
            onClose();
          } else if (confirmation?.type === "disconnect") {
            setConfirmBusy(true);
            void confirmation.action().finally(() => {
              setConfirmBusy(false);
              setConfirmation(null);
            });
          }
        }}
      />
    </DrawerShell>
  );
}

function RemoteManagedConnection({
  url,
  headers,
  onChange,
  onDisconnect,
}: {
  url: string;
  headers?: Record<string, string>;
  onChange: (connection: McpConnection) => void;
  onDisconnect: (action: () => Promise<void>) => void;
}) {
  const controller = useMcpConnection({ url, headers, onChange });
  return (
    <McpConnectionSection
      controller={controller}
      url={url}
      onDisconnect={() => onDisconnect(controller.disconnect)}
    />
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-3">
      <dt className="text-[var(--color-text-muted)]">{label}</dt>
      <dd className="break-all">{value}</dd>
    </div>
  );
}
