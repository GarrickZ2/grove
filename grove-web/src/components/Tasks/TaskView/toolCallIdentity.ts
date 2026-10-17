import type { ToolCallMessage } from "./toolCallReducer";

type Identity = Pick<ToolCallMessage, "title" | "name" | "kind">;
export type ActionKind = "bash" | "bash_output" | "skill" | "todo" | "mcp" | "permission" | "read" | "edit" | "delete" | "move" | "search" | "fetch" | "switch_mode" | "generic";
type ToolVerb = "read" | "edit" | "run" | "search" | "list" | "plan" | "permission" | "fetch" | "delete" | "move" | "switch_mode" | "other";

const NAME_VERBS: Record<string, ToolVerb> = {
  read: "read", read_file: "read", readfile: "read", read_many_files: "read",
  edit: "edit", edit_file: "edit", editfile: "edit", write: "edit", write_file: "edit", writefile: "edit", create_file: "edit", apply_patch: "edit", multiedit: "edit", replace: "edit", str_replace_editor: "edit",
  bash: "run", shell: "run", run_command: "run", exec_command: "run", write_stdin: "run", terminal: "run", bash_output: "run",
  search: "search", grep: "search", glob: "search", ripgrep: "search", search_files: "search", toolsearch: "search",
  list: "list", ls: "list", list_directory: "list", list_files: "list",
  todo_write: "plan", todowrite: "plan", update_plan: "plan",
  webfetch: "fetch", web_fetch: "fetch", fetch: "fetch", websearch: "search", web_search: "search",
};

/** Preserve the tool identity independently of operation categories and payloads. */
export function toolDisplayName(message: Pick<Identity, "name" | "title">): string {
  return message.name?.trim() || message.title?.trim() || "Tool";
}

/** Names are Agent-specific identifiers, not capability declarations. Only
 * known aliases receive special treatment; unknown names keep their category. */
export function toolVerb(message: Identity): ToolVerb {
  const categories: Record<string, ToolVerb> = {
    read: "read", edit: "edit", execute: "run", search: "search",
    fetch: "fetch", delete: "delete", move: "move", switch_mode: "switch_mode",
  };
  const name = message.name?.trim().toLowerCase();
  if (message.kind === "read" && name && NAME_VERBS[name] === "list") return "list";
  if (message.kind && categories[message.kind]) return categories[message.kind];
  if (name) return NAME_VERBS[name] ?? "other";
  const title = message.title.toLowerCase().trim();
  if (NAME_VERBS[title]) return NAME_VERBS[title];
  if (title.startsWith("read")) return "read";
  if (title.startsWith("edit") || title.startsWith("write")) return "edit";
  if (title.startsWith("run")) return "run";
  if (title.startsWith("search") || title.startsWith("find")) return "search";
  if (title.startsWith("list") || title.startsWith("ls")) return "list";
  if (title.includes("permission")) return "permission";
  return "other";
}

export function isEditTool(message: Identity): boolean {
  return toolVerb(message) === "edit";
}

export function classifyActionKind(message: Identity): ActionKind {
  const identity = (message.name || message.title).toLowerCase().trim();
  if (identity === "bash_output") return "bash_output";
  if (identity === "skill" || identity === "skill_use") return "skill";
  if (/^mcp(?:__|[_.:/])/.test(identity)) return "mcp";
  const verb = toolVerb(message);
  if (verb === "run") return "bash";
  if (verb === "plan") return "todo";
  if (verb === "list") return "read";
  if (verb === "other") return "generic";
  return verb;
}

export function isBackgroundAction(message: Identity): boolean {
  const verb = toolVerb(message);
  return ["read", "search", "list", "fetch"].includes(verb)
    || (message.name || message.title).toLowerCase().trim() === "terminal";
}

export function isGroveMemoryReadName(name: string): boolean {
  const normalized = name.toLowerCase().trim();
  return normalized === "memory_read"
    || /^(?:mcp[_.:/]+)?grove_agent[_.:/]+memory_read$/.test(normalized);
}
