import type { CommandDef } from "../types";

/**
 * Agent panel session commands — sending messages, search, forking
 * sessions, mentions, slash commands, and attachments inside the
 * Agent panel (TaskChat).
 *
 * Ids remain `chat.*` so existing user keymap overrides keep working;
 * only the user-facing strings reflect the Agent + Session vocabulary.
 *
 * Scopes:
 *   workspace  — TaskView (inside a task)
 */
export const CHAT_COMMANDS: CommandDef[] = [
  {
    id: "chat.send",
    name: "Send Message",
    category: "Session",
    description: "Send the current message",
    defaultBindings: [{ key: "Enter" }],
    scope: "workspace",
    defaultWhen: "chatFocus && messageNotEmpty && !chatInputExpanded",
  },
  {
    id: "chat.send.alt",
    name: "Send Message (Cmd+Enter)",
    category: "Session",
    description: "Send the current message via Cmd+Enter",
    defaultBindings: [{ key: "Mod+Enter" }],
    scope: "workspace",
    defaultWhen: "chatFocus",
  },
  {
    id: "chat.search.toggle",
    name: "Toggle Session Search",
    category: "Session",
    description: "Open or close the session search bar",
    defaultBindings: [{ key: "Mod+f" }],
    scope: "workspace",
    defaultWhen: "chatPanelActive",
  },
  {
    id: "chat.fork",
    name: "Fork Session",
    category: "Session",
    description: "Fork the session at the selected message",
    scope: "workspace",
    defaultWhen: "chatPanelActive && messageSelected",
  },
  {
    id: "chat.clear",
    name: "Clear Session",
    category: "Session",
    description: "Clear the current session history",
    scope: "workspace",
    defaultWhen: "chatPanelActive",
  },
  {
    id: "chat.mention.file",
    name: "Mention File",
    category: "Session",
    description: "Insert a file mention into the composer",
    scope: "workspace",
    defaultWhen: "chatFocus",
  },
  {
    id: "chat.mention.agent",
    name: "Mention Agent",
    category: "Session",
    description: "Insert an agent mention into the composer",
    scope: "workspace",
    defaultWhen: "chatFocus",
  },
  {
    id: "chat.slash.command",
    name: "Execute Slash Command",
    category: "Session",
    description: "Trigger a slash command from the composer",
    scope: "workspace",
    defaultWhen: "chatFocus",
  },
  {
    id: "chat.scrollToBottom",
    name: "Scroll to Latest",
    category: "Session",
    description: "Jump to the latest message in the session",
    // No default key: Mod+Alt+ArrowDown clashed with workspace.nav.cycleNext
    // (same workspace scope). Auto-scroll + the jump-to-latest button already
    // cover this; configurable in Settings for anyone who wants a key.
    scope: "workspace",
    defaultWhen: "chatPanelActive",
  },
  {
    id: "chat.permission.cycle",
    name: "Cycle Permission Mode",
    category: "Session",
    description: "Cycle through the agent's permission modes for the next prompt",
    defaultBindings: [{ key: "Shift+Tab" }],
    scope: "workspace",
    defaultWhen: "chatFocus",
    passThroughTextInput: true,
  },
  {
    id: "chat.pending.clear",
    name: "Clear Pending Queue",
    category: "Session",
    description: "Discard all queued (unsent) messages in the composer",
    defaultBindings: [{ key: "Mod+Alt+Backspace" }],
    scope: "workspace",
    defaultWhen: "chatFocus",
    passThroughTextInput: true,
  },
  {
    id: "chat.attachment.add",
    name: "Attach File",
    category: "Session",
    description: "Attach a file to the current message",
    scope: "workspace",
    defaultWhen: "chatFocus",
  },
  {
    id: "chat.switchSession",
    name: "Switch Session",
    category: "Session",
    description: "Switch to a specific chat session by its ID or title",
    scope: "workspace",
  },
];
