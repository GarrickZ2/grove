import type { AgentConfigSelection } from "../../api/agentConfig";
import type { SessionConfigOption } from "../../api/tasks";

const SAVED_SELECTIONS_KEY = "grove-orbit-new-config";

/** Wire shape of the per-prompt config the backend applies before a prompt (`QueuedConfig`). */
export interface QueuedPromptConfig {
  mode?: string;
  config_options?: Record<string, string | boolean>;
}

/**
 * The first prompt carries everything the New page shows, not just what was
 * touched: a value on screen is only the Agent's last known state, and a new
 * session can start from a different one.
 */
export function promptConfigFromSelection(selection: AgentConfigSelection, options: readonly SessionConfigOption[] = []): QueuedPromptConfig | undefined {
  if (selection.source === "config_options") {
    const values = { ...Object.fromEntries(options.map((option) => [option.id, option.currentValue])), ...selection.values };
    return Object.keys(values).length > 0 ? { config_options: values } : undefined;
  }
  if (selection.source === "modes") return { mode: selection.mode_id };
  return undefined;
}

function readSavedSelections(): Record<string, AgentConfigSelection> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SAVED_SELECTIONS_KEY) ?? "{}");
    return saved && typeof saved === "object" ? saved as Record<string, AgentConfigSelection> : {};
  } catch {
    return {};
  }
}

/** Per-viewer convenience: what this Agent was last set to on the New page. */
export function readSavedSelection(agentId: string): AgentConfigSelection | undefined {
  const saved = readSavedSelections()[agentId];
  return saved?.agent_id === agentId ? saved : undefined;
}

export function saveSelection(selection: AgentConfigSelection): void {
  if (!selection.agent_id) return;
  try {
    localStorage.setItem(SAVED_SELECTIONS_KEY, JSON.stringify({ ...readSavedSelections(), [selection.agent_id]: selection }));
  } catch { /* per-viewer convenience only */ }
}
