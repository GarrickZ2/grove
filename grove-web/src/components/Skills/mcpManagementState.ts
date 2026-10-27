import type {
  ExtensionArtifact,
  McpConnection,
  McpInstallation,
} from "../../api/extensions";

export interface McpBindingDraft {
  agentIds: string[];
  values: Record<string, string>;
  runtime: { kind: "remote" | "package"; index: number };
}
export type McpScope = "global" | "project";

export function needsMcpAgentSetup(artifact: ExtensionArtifact): boolean {
  return (
    artifact.kind === "mcp" &&
    artifact.installed_agents.length === 0 &&
    !!artifact.mcp_connections?.some(
      (connection) =>
        connection.status === "authorized" || connection.status === "public",
    )
  );
}

export function requiresMcpAuthorization(
  connection: McpConnection | null,
): boolean {
  return (
    connection?.auth_type === "oauth" &&
    (connection.status === "auth_required" || !connection.has_credentials)
  );
}

export function bindingDraft(
  items: McpInstallation[],
  scope: McpScope,
  projectPath: string | null,
  fallback: McpBindingDraft["runtime"],
): McpBindingDraft {
  const matches = items.filter(
    (item) =>
      item.scope === scope &&
      item.project_path === (scope === "project" ? projectPath : ""),
  );
  return {
    agentIds: matches.map((item) => item.agent_id),
    values: { ...matches[0]?.values },
    runtime: matches[0]?.runtime ?? fallback,
  };
}

export function sameBindingDraft(
  a: McpBindingDraft,
  b: McpBindingDraft,
): boolean {
  return (
    a.runtime.kind === b.runtime.kind &&
    a.runtime.index === b.runtime.index &&
    JSON.stringify([...a.agentIds].sort()) ===
      JSON.stringify([...b.agentIds].sort()) &&
    JSON.stringify(Object.entries(a.values).sort()) ===
      JSON.stringify(Object.entries(b.values).sort())
  );
}

export function connectionPresentation(connection: McpConnection | null) {
  switch (connection?.status) {
    case "authorized":
      return {
        label: "Authorized",
        detail: "Authorization is saved in Grove.",
        tone: "success" as const,
      };
    case "public":
      return {
        label: "Connected",
        detail: "Server connection verified. Configure Agent access to use it.",
        tone: "success" as const,
      };
    case "auth_required":
      return {
        label: "Authorization required",
        detail:
          connection.auth_type === "oauth"
            ? "Sign in to connect your account."
            : "Provide the credentials requested by this server.",
        tone: "warning" as const,
      };
    case "expired":
      return {
        label: "Token expired",
        detail: "Grove will try to refresh it on the next connection.",
        tone: "warning" as const,
      };
    case "error":
      return {
        label: "Connection failed",
        detail: "Check the connection and try again.",
        tone: "danger" as const,
      };
    default:
      return {
        label: "Not checked",
        detail: "Check this server before using it.",
        tone: "neutral" as const,
      };
  }
}
