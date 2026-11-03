const BUDDY_TOOLS: Record<string, string> = {
  list_projects: "Looking through projects", list_tasks: "Checking tasks", list_sessions: "Checking sessions", read_session: "Reading a conversation",
  send: "Handing off work", send_message: "Sending a message", create_task: "Creating a task", delegate: "Handing work to a subagent", list_delegations: "Checking delegations",
  list_followups: "Checking on handed-off work", cancel_followup: "Stopping handed-off work", manage_queue: "Managing queued messages", respond: "Answering a request",
  create_project: "Creating a project", search_sessions: "Searching conversations",
  list_routines: "Checking routines", create_routine: "Setting up a routine", update_routine: "Updating a routine", delete_routine: "Removing a routine", run_routine: "Running a routine",
};
const LEGACY_BUDDY_TOOLS: Record<string, string> = { delegations: "list_delegations", routine_list: "list_routines", routine_create: "create_routine", routine_update: "update_routine", routine_delete: "delete_routine", routine_run: "run_routine" };

/** A plain-language phrase for the current step. Tool names, paths and commands never reach the conversation. */
export function friendlyStep(title: string): string {
  if (title === "Thinking…" || title === "Planning next steps") return title;
  const name = title.trim().replace(/^mcp__.+?__/, "").replace(/^buddy_/, "");
  const tool = BUDDY_TOOLS[name] ?? BUDDY_TOOLS[LEGACY_BUDDY_TOOLS[name]];
  if (tool) return tool;
  if (/^memory_/.test(name)) return "Checking memory";
  if (/^browser_|^(web ?)?fetch\b/i.test(name)) return "Browsing the web";
  if (/^web ?search\b/i.test(name)) return "Searching the web";
  if (/^tool ?search\b/i.test(name)) return "Looking for the right tool";
  if (/^read\b|^view\b/i.test(name)) return "Reading files";
  if (/^(edit|write|multiedit|apply)\b/i.test(name)) return "Editing files";
  if (/^(grep|glob|search|find)\b/i.test(name)) return "Searching";
  if (/^`|^(bash|terminal|run|execute)\b/i.test(name)) return "Running a command";
  return "Working…";
}
