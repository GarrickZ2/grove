import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, Server } from "lucide-react";
import { Button } from "../ui";
import type { McpServerInfo } from "../../api/extensions";
import { ExtensionIdentityIcon } from "./ExtensionIdentityIcon";
import { McpAgentAccess } from "./McpAgentAccess";
import {
  McpDisclosure,
  McpFeedback,
  mcpInputClass,
} from "./McpConnectionViews";
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
import { useMcpPackageConnection } from "./useMcpPackageConnection";
import { mcpErrorText } from "./useMcpConnection";

const schema =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

export function PackageAddForm({
  runtime,
  onSetupChange,
  onClose,
  access,
  onCreate,
  definitionLocked,
  onSaving,
}: {
  runtime: Exclude<Runtime, "remote">;
  onSetupChange: (active: boolean) => void;
  onClose: () => void;
  onSaving: (value: boolean) => void;
} & SetupProps) {
  const [identifier, setIdentifier] = useState("");
  const [version, setVersion] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [argumentsText, setArgumentsText] = useState("");
  const [variables, setVariables] = useState<Variable[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [started, setStarted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const controller = useMcpPackageConnection();
  const verified = controller.probe?.status === "complete";
  const info = verified ? controller.probe?.server_info : null;
  const fields = definitions(variables);
  const credentials = Object.fromEntries(
    fields.flatMap((field) =>
      values[field.name] === undefined
        ? []
        : [[field.name, values[field.name]]],
    ),
  );
  const packageDefinition = {
    registryType: runtime,
    identifier: identifier.trim(),
    ...(version.trim() ? { version: version.trim() } : {}),
    ...(fields.length ? { environmentVariables: fields } : {}),
    ...(argumentsText.trim()
      ? {
          packageArguments: argumentsText
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean)
            .map((value) => ({ value })),
        }
      : {}),
  };
  const credentialsReady = fields.every(
    (field) => !field.isRequired || values[field.name]?.trim(),
  );
  const finalName =
    name.trim() || info?.title || info?.name || identifier.trim();
  const canSave =
    verified &&
    credentialsReady &&
    access.draft.agentIds.length > 0 &&
    !access.loading &&
    !access.error;
  const invalidate = () => {
    controller.reset();
    setSaveError(null);
  };
  const connect = () => {
    if (!identifier.trim() || !credentialsReady) return;
    setStarted(true);
    onSetupChange(true);
    setSaveError(null);
    void controller.check({ package: packageDefinition, values: credentials });
  };
  const create = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    onSaving(true);
    setSaveError(null);
    try {
      await onCreate(
        {
          $schema: schema,
          name: finalName,
          version: info?.version || "unknown",
          description: description.trim() || info?.description || "",
          ...(info?.icons.length ? { icons: info.icons } : {}),
          ...(info?.website_url ? { websiteUrl: info.website_url } : {}),
          packages: [packageDefinition],
        },
        credentials,
      );
    } catch (cause) {
      setSaveError(mcpErrorText(cause));
    } finally {
      setSaving(false);
      onSaving(false);
    }
  };
  const busy = controller.busy || saving;
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) {
          if (verified) void create();
          else connect();
        }
      }}
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
        {verified ? (
          <>
            <div className="flex items-start gap-3">
              <ExtensionIdentityIcon
                kind="mcp"
                name={finalName}
                manifest={{ icons: info?.icons ?? [] }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <p className="text-base font-semibold">{finalName}</p>
                    {info?.version && (
                      <span className="text-xs text-[var(--color-text-muted)]">
                        v{info.version}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={busy || definitionLocked}
                    className="rounded text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-highlight)]"
                    onClick={() => {
                      invalidate();
                      setStarted(false);
                      onSetupChange(false);
                    }}
                  >
                    Change
                  </button>
                </div>
                <p className="mt-2 break-all font-mono text-xs leading-5 text-[var(--color-text-muted)]">
                  {identifier}
                  {version.trim() ? ` · ${version.trim()}` : ""}
                </p>
                {info?.description && (
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--color-text-muted)]">
                    {info.description}
                  </p>
                )}
              </div>
            </div>
            <p
              role="status"
              className="flex items-center gap-2 text-xs text-[var(--color-success)]"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Connection verified
              {controller.probe?.tool_count != null
                ? ` · ${controller.probe.tool_count} tools`
                : ""}
            </p>
            <div className="border-t border-[var(--color-border)] pt-5">
              <McpAgentAccess {...access} />
            </div>
            <McpDisclosure title="Edit display details">
              <fieldset
                disabled={busy || definitionLocked}
                className="space-y-3"
              >
                <label className="block text-xs font-medium">
                  Display name
                  <input
                    className={mcpInputClass}
                    placeholder={info?.title || info?.name || identifier}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="block text-xs font-medium">
                  Description
                  <input
                    className={mcpInputClass}
                    placeholder={info?.description || "Optional"}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </label>
              </fieldset>
            </McpDisclosure>
          </>
        ) : (
          <>
            {started && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium">{runtime.toUpperCase()}</p>
                <button
                  type="button"
                  disabled={saving || definitionLocked}
                  className="rounded text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-highlight)]"
                  onClick={() => {
                    invalidate();
                    setStarted(false);
                    onSetupChange(false);
                  }}
                >
                  Change
                </button>
              </div>
            )}
            <fieldset disabled={busy || definitionLocked} className="space-y-4">
              <label className="block text-xs font-medium">
                {runtime === "oci" ? "Image" : "Package name"}
                <input
                  data-autofocus
                  className={mcpInputClass}
                  placeholder={
                    runtime === "npm"
                      ? "@company/mcp-server"
                      : runtime === "pypi"
                        ? "mcp-server-package"
                        : "ghcr.io/company/mcp-server"
                  }
                  value={identifier}
                  onChange={(event) => {
                    invalidate();
                    setIdentifier(event.target.value);
                  }}
                />
              </label>
              <label className="block text-xs font-medium">
                {runtime === "oci" ? "Image tag" : "Package version"}
                <input
                  className={mcpInputClass}
                  placeholder="Default"
                  value={version}
                  onChange={(event) => {
                    invalidate();
                    setVersion(event.target.value);
                  }}
                />
                <span className="mt-1 block text-xs font-normal leading-5 text-[var(--color-text-muted)]">
                  Optional. The server’s own version will be read after
                  connecting.
                </span>
              </label>
            </fieldset>
            {!started && (
              <p className="text-xs leading-5 text-[var(--color-text-muted)]">
                Grove will start this package locally, read its details, and
                check its tools.
              </p>
            )}
            {controller.busy && (
              <div
                role="status"
                className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-4 py-3.5"
              >
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                <div>
                  <p className="text-sm font-medium">Starting and checking…</p>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
                    The first connection may download the package. You can
                    cancel while it starts.
                  </p>
                </div>
              </div>
            )}
          </>
        )}
        <McpDisclosure
          title="Startup settings"
          defaultOpen={started && !verified && !controller.busy}
        >
          <fieldset disabled={busy || definitionLocked} className="space-y-3">
            <VariableDefinitions
              variables={variables}
              onChange={(value) => {
                invalidate();
                setVariables(value);
              }}
              remote={false}
            />
            <label className="block text-xs font-medium">
              Arguments
              <textarea
                className={mcpInputClass}
                rows={3}
                placeholder="One argument per line"
                value={argumentsText}
                onChange={(event) => {
                  invalidate();
                  setArgumentsText(event.target.value);
                }}
              />
            </label>
          </fieldset>
          <McpSetupCredentials
            variables={variables}
            values={values}
            onChange={(value) => {
              invalidate();
              setValues(value);
            }}
            disabled={busy}
          />
          <p className="text-xs leading-5 text-[var(--color-text-muted)]">
            Enter any required environment variables before connecting. Changes
            require another connection check.
          </p>
        </McpDisclosure>
        <McpFeedback error={saveError || controller.error} />
      </div>
      <Footer
        onClose={onClose}
        busy={saving}
        label={
          controller.busy
            ? "Connecting…"
            : saving
              ? "Adding…"
              : verified
                ? definitionLocked
                  ? "Retry enabling"
                  : "Add & enable"
                : started
                  ? "Retry connection"
                  : "Connect"
        }
        disabled={
          controller.busy ||
          !identifier.trim() ||
          !credentialsReady ||
          (verified && !canSave)
        }
        hint={
          verified && !access.draft.agentIds.length
            ? "Choose at least one Agent"
            : undefined
        }
      />
    </form>
  );
}

export function PackageManagedConnection({
  packageDefinition,
  values,
  onChange,
}: {
  packageDefinition: Definition;
  values: Record<string, string>;
  onChange: (info: McpServerInfo) => void;
}) {
  const controller = useMcpPackageConnection();
  const connected = controller.probe?.status === "complete";
  const check = async () => {
    await controller.check({ package: packageDefinition, values });
  };
  useEffect(() => {
    if (controller.probe?.status === "complete" && controller.probe.server_info)
      onChange(controller.probe.server_info);
  }, [controller.probe, onChange]);
  return (
    <PackageConnectionResult
      controller={controller}
      packageDefinition={packageDefinition}
      onCheck={() => void check()}
      connected={connected}
    />
  );
}

function PackageConnectionResult({
  controller,
  packageDefinition,
  onCheck,
  connected,
}: {
  controller: ReturnType<typeof useMcpPackageConnection>;
  packageDefinition: Definition;
  onCheck: () => void;
  connected: boolean;
}) {
  // Metadata is delivered through the hook callback, not during render.
  return (
    <section className="space-y-3" aria-label="Package connection">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Connection</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={controller.busy}
          onClick={onCheck}
        >
          <RefreshCw
            className={`mr-1.5 h-3.5 w-3.5 ${controller.busy ? "animate-spin" : ""}`}
          />
          Check connection
        </Button>
      </div>
      <p className="break-all font-mono text-xs text-[var(--color-text-muted)]">
        {String(packageDefinition.registryType)} ·{" "}
        {String(packageDefinition.identifier)}
        {packageDefinition.version
          ? ` · ${String(packageDefinition.version)}`
          : ""}
      </p>
      <div className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 px-4 py-3.5">
        {controller.busy ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
        ) : connected ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" />
        ) : (
          <Server className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
        )}
        <div>
          <p className="text-sm font-medium">
            {controller.busy
              ? "Starting and checking…"
              : connected
                ? "Connection verified"
                : controller.error
                  ? "Connection failed"
                  : "Not checked"}
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            {connected
              ? `${controller.probe?.tool_count != null ? `${controller.probe.tool_count} tools available. ` : ""}Agent access is configured below.`
              : "Grove starts a temporary process to check this package and read its details."}
          </p>
        </div>
      </div>
      <McpFeedback error={controller.error} />
    </section>
  );
}
