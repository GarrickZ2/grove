import type { CommandDef } from "../types";

/**
 * Agent lifecycle commands.
 *
 * We deliberately do NOT register one command per built-in agent. That
 * design doesn't scale: custom agents and marketplace-installed agents
 * can't be predeclared in the catalog, so a per-agent surface would
 * always be incomplete. Instead we expose two general-purpose commands:
 *
 *   agent.new.default   — Create a session with the project's default
 *                         agent (fastest path; rebindable to whatever
 *                         the user uses most).
 *   agent.picker.show   — Pop the agent picker; the picker lists every
 *                         available agent (built-in + custom +
 *                         marketplace) and the user chooses with
 *                         arrow keys + Enter.
 *
 * Scopes:
 *   workspace  — TaskView (inside a task)
 */
export const AGENT_COMMANDS: CommandDef[] = [
  {
    id: "agent.new.default",
    name: "New Session (Default Agent)",
    category: "Agent",
    description: "Create a new chat session in the current task using the default agent",
    // Mod+N is the browser's "new window"; use Mod+Alt+N (N = New).
    defaultBindings: [{ key: "Mod+Alt+n" }],
    scope: "workspace",
  },
  {
    id: "agent.picker.show",
    name: "Show Agent Picker",
    category: "Agent",
    description: "Open the agent picker — choose any built-in, custom, or installed agent for a new session",
    // Mod+Shift+N is the browser's "new incognito window"; use Mod+Alt+Shift+N
    // (the "choose which agent" variant of Mod+Alt+N).
    defaultBindings: [{ key: "Mod+Alt+Shift+n" }],
    scope: "workspace",
  },
  {
    id: "agent.switch.next",
    name: "Switch to Next Session",
    category: "Agent",
    description: "Focus the next active session in the current task",
    defaultBindings: [{ key: "Mod+Alt+ArrowRight" }],
    scope: "workspace",
  },
  {
    id: "agent.switch.previous",
    name: "Switch to Previous Session",
    category: "Agent",
    description: "Focus the previous active session in the current task",
    defaultBindings: [{ key: "Mod+Alt+ArrowLeft" }],
    scope: "workspace",
  },
];
