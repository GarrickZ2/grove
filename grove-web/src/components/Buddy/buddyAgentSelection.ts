import type { Buddy } from "../../api/buddies";
import type { InstalledAgentConfig } from "../../api/marketplace";
import { configForAgent } from "../../utils/agentConfig";
import { quickConfigOptions } from "../Tasks/TaskView/sessionConfigOptions";

/** Preserve legacy preferences when the existing catalog now exposes config options. */
export function buddyAgentSelection(buddy: Buddy, agent?: InstalledAgentConfig) {
  if (buddy.agent_config.source !== "default" || !agent) return buddy.agent_config;
  const selection = configForAgent(agent);
  if (selection.source !== "config_options") return selection;
  const quick = quickConfigOptions(agent.capability_snapshot?.config_options ?? []);
  for (const [value, option] of [[buddy.model, quick.model], [buddy.mode, quick.mode], [buddy.effort, quick.thinking]] as const) {
    if (value && option) selection.values[option.id] = value;
  }
  return selection;
}
