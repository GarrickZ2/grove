import type { AgentConfigSelection } from "../../api/agentConfig";

/** Wire shape of the per-prompt config the backend applies before a prompt (`QueuedConfig`). */
export interface QueuedPromptConfig {
  mode?: string;
  config_options?: Record<string, string | boolean>;
}

/** Only explicit overrides travel with the first prompt; untouched options keep the Agent default. */
export function promptConfigFromSelection(selection: AgentConfigSelection): QueuedPromptConfig | undefined {
  if (selection.source === "config_options") {
    return Object.keys(selection.values).length > 0 ? { config_options: selection.values } : undefined;
  }
  if (selection.source === "modes") return { mode: selection.mode_id };
  return undefined;
}
