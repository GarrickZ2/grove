import type { InstalledAgentConfig } from "./marketplace";

export function buddyAgentFixtures(): InstalledAgentConfig[] {
      return ["codex", "claude-code"].map((id) => ({ id, name: id === "codex" ? "Codex" : "Claude Code", capability_updated_at: "2026-10-30T18:00:00.000Z",
        capability_snapshot: { uses_config_options: true, config_options: [
          { id: "model", name: "Model", type: "select", category: "model", currentValue: "mock-model", options: [{ value: "mock-model", name: "Example model" }] },
          { id: "effort", name: "Effort", type: "select", category: "thought_level", currentValue: "medium", options: ["low", "medium", "high"].map((value) => ({ value, name: value })) },
        ] } }));
    }
