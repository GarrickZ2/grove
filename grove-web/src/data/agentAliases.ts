/**
 * Agent ID alias map.
 *
 * Builtin agents used short ids (e.g. `claude`, `codex`) that don't match the
 * standardized ids used by the ACP registry (`claude-acp`, `codex-acp`). When
 * the marketplace layer merges registry data with builtin supplement data, it
 * goes through this map so a chat created on the old id continues to resolve
 * to the same merged agent record.
 *
 * Rules:
 * - Keys are LEGACY ids (used by existing ChatSession.agent values, old
 *   config.acp.agent_command, persona.base_agent, etc.).
 * - Values are CANONICAL ids (the registry id when available, else the
 *   supplement id).
 * - resolveAgentId() returns the canonical id; ids not in the map are
 *   passed through unchanged (covers ids that were already canonical and
 *   future registry additions).
 *
 * We intentionally do NOT migrate existing DB rows — old `chat.agent =
 * "claude"` keeps working forever via this lookup. Removing an alias is a
 * breaking change for any chat persisted with the legacy id, so once an
 * entry lands here it stays.
 */

const AGENT_ID_ALIASES: Record<string, string> = {
  claude: "claude-acp",
  codex: "codex-acp",
  "cursor-agent": "cursor",
  "gh-copilot": "github-copilot-cli",
  qwen: "qwen-code",
};

/** Resolve any legacy or canonical agent id to its canonical form. */
export function resolveAgentId(id: string): string {
  return AGENT_ID_ALIASES[id] ?? id;
}

/** All legacy ids that resolve to the given canonical id (reverse lookup). */
export function legacyAliasesFor(canonicalId: string): string[] {
  return Object.entries(AGENT_ID_ALIASES)
    .filter(([, canonical]) => canonical === canonicalId)
    .map(([legacy]) => legacy);
}
