/**
 * Agent → brand-color mapping for the Statistics page.
 *
 * Colors match the dominant hue of each agent's icon under
 * `grove-web/public/agent-icon/`. Used everywhere the stats page renders an
 * agent — bars, donut wedges, time-series fills, top-list splits.
 *
 * Adding a new agent: add a row keyed by the canonical agent key (the
 * `key` value used in `utils/agentIcon.ts`'s AGENT_TABLE). Aliases resolve
 * via `agentIconForKey` upstream, so this map only needs canonical keys
 * plus a sensible fallback for anything else.
 */

import { resolveAgentIcon } from "../../utils/agentIcon";

const COLOR_BY_CANONICAL: Record<string, string> = {
  claude: "#cc785c", // Anthropic terracotta
  codex: "#10a37f", // OpenAI green
  gemini: "#4285f4", // Google blue
  cursor: "#1f1f1f", // black on light, mid-gray on dark
  copilot: "#7c3aed", // GitHub Copilot purple
  hermes: "#6b6b6b", // illustrated mid-gray
  junie: "#22c55e", // Junie green
  kimi: "#1e3a8a", // dark blue from K mark
  kiro: "#a855f7", // Kiro purple
  openclaw: "#dc2626", // red claw
  opencode: "#1e1e1e", // black square
  qwen: "#7c3aed", // purple gradient
  traecli: "#16a34a", // Trae green
  windsurf: "#0284c7", // teal-blue
};

/**
 * Fallback palette — hashed from the agent key — for unknown / custom agents.
 * Picks visually distinct hues so multiple unknown personas don't collide.
 */
const FALLBACK_PALETTE = [
  "#64748b", // slate
  "#0ea5e9", // sky
  "#f59e0b", // amber
  "#ec4899", // pink
  "#14b8a6", // teal
  "#a855f7", // purple
  "#84cc16", // lime
];

function hashIndex(input: string, modulo: number): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % modulo;
}

/**
 * Returns the hex color for an agent. `key` may be any value that
 * `agentIconForKey` understands (canonical, alias, label).
 */
export function agentColor(key: string): string {
  const info = resolveAgentIcon(key);
  const canonical = info.canonicalKey || key.toLowerCase();
  const hit = COLOR_BY_CANONICAL[canonical];
  if (hit) return hit;
  return FALLBACK_PALETTE[hashIndex(canonical, FALLBACK_PALETTE.length)];
}
