/**
 * Single source of truth for "given an agent key, what icon do I render?"
 *
 * The codebase has at least four conventions for naming agents:
 *   - `agentOptions[].value` (e.g. "claude", "codex") — the spawn / config key
 *   - `agentOptions[].id`    (e.g. "claude", "codex", "gh-copilot")
 *   - skills builtin `id`   (e.g. "claude-code", "gemini-cli")
 *   - skills builtin `icon_id` (e.g. "claude", "openai")
 *   - the static svg filename under `/agent-icon/`
 *
 * Every place that wants an icon used to re-implement the lookup with
 * inconsistent fallbacks. This module normalizes the input, returns:
 *   - a static URL for raw-DOM use (image chips, hover cards, etc.)
 *   - a React component for JSX use (mirrors `agentOptions[].icon`)
 *   - a friendly label
 *
 * Adding a new agent: add a row to `AGENT_TABLE`. That's it. Both the static
 * URL and the React component come for free; downstream call sites don't
 * change.
 */

import { useSyncExternalStore, type ComponentType } from "react";
import { Bot } from "lucide-react";
import {
  Claude,
  Gemini,
  Copilot,
  Cursor,
  Trae,
  Qwen,
  Kimi,
  OpenAI,
  Junie,
  OpenCode,
  OpenClaw,
  Hermes,
  Kiro,
  Windsurf,
} from "../components/ui/AgentIcons";

export interface AgentIconInfo {
  /** React component rendering the brand icon. Falls back to lucide `Bot`
   *  for unknown keys so consumers always get something renderable. */
  Component: ComponentType<{ size?: number; className?: string }>;
  /** Direct path to the static SVG, or `null` when no static asset exists. */
  url: string | null;
  /** Human-readable label, e.g. "Claude Code", "CodeX". */
  label: string;
  /** Canonical agent key — the value an `agentOptions` row would carry.
   *  Useful for downstream code that needs a stable id (e.g. metadata
   *  payloads). */
  canonicalKey: string;
}

interface AgentRow {
  /** Canonical key — what `agentOptions[].value` uses. */
  key: string;
  label: string;
  /** Filename under `/agent-icon/`, no path. `null` if no static asset. */
  staticFile: string | null;
  /** React component reference (or `null` to fall back to `Bot`). */
  Component: ComponentType<{ size?: number; className?: string }> | null;
  /** Extra strings that should resolve to this row (skills ids, legacy ids,
   *  icon_id values, alternate filenames, etc.). */
  aliases?: string[];
}

const AGENT_TABLE: AgentRow[] = [
  {
    key: "claude",
    label: "Claude Code",
    staticFile: "claude-color.svg",
    Component: Claude.Color,
    aliases: ["claude-code", "claude-color", "claude code"],
  },
  {
    key: "codex",
    label: "CodeX",
    staticFile: "openai.svg",
    Component: OpenAI,
    aliases: ["openai"],
  },
  {
    key: "gemini",
    label: "Gemini",
    staticFile: "gemini-color.svg",
    Component: Gemini.Color,
    aliases: ["gemini-cli", "gemini-color"],
  },
  {
    key: "cursor",
    label: "Cursor",
    staticFile: "cursor.svg",
    Component: Cursor,
    aliases: ["cursor-agent"],
  },
  {
    key: "copilot",
    label: "GitHub Copilot",
    staticFile: "githubcopilot.svg",
    Component: Copilot.Color,
    aliases: ["gh-copilot", "githubcopilot", "github copilot"],
  },
  {
    key: "hermes",
    label: "Hermes",
    staticFile: "hermes.svg",
    Component: Hermes,
  },
  {
    key: "junie",
    label: "Junie",
    staticFile: "junie-color.svg",
    Component: Junie.Color,
    aliases: ["junie-color"],
  },
  {
    key: "kimi",
    label: "Kimi",
    staticFile: "kimi-color.svg",
    Component: Kimi.Color,
    aliases: ["kimi-color"],
  },
  {
    key: "kiro",
    label: "Kiro",
    staticFile: "kiro.svg",
    Component: Kiro,
    aliases: ["kiro-cli"],
  },
  {
    key: "openclaw",
    label: "OpenClaw",
    staticFile: "openclaw-color.svg",
    Component: OpenClaw.Color,
    aliases: ["openclaw-color"],
  },
  {
    key: "opencode",
    label: "OpenCode",
    staticFile: "opencode.svg",
    Component: OpenCode,
  },
  {
    key: "qwen",
    label: "Qwen",
    staticFile: "qwen-color.svg",
    Component: Qwen.Color,
    aliases: ["qwen-color"],
  },
  {
    key: "traecli",
    label: "Trae",
    staticFile: "trae-color.svg",
    Component: Trae.Color,
    aliases: ["trae", "trae-color"],
  },
  {
    key: "windsurf",
    label: "Windsurf",
    staticFile: "windsurf.svg",
    Component: Windsurf,
  },
];

const TABLE_BY_KEY: Record<string, AgentRow> = (() => {
  const map: Record<string, AgentRow> = {};
  for (const row of AGENT_TABLE) {
    const keys = [row.key, ...(row.aliases ?? [])];
    for (const k of keys) {
      // Last-write-wins on collisions; aliases shouldn't collide in practice.
      map[k.toLowerCase()] = row;
    }
  }
  return map;
})();

const FALLBACK: AgentIconInfo = {
  Component: Bot,
  url: null,
  label: "",
  canonicalKey: "",
};

// ─── Custom Agent (persona) registry ─────────────────────────────────────────
//
// Personas live in the SQLite custom_agent table — pages that list / consume
// agents (TaskChat, TaskGraph, SettingsPage) call `setCustomAgentPersonas`
// after fetching them so this module can transparently resolve a persona id
// to its underlying base agent's brand icon. Label is overridden to the
// persona's display name so consumers using `info.label` show e.g.
// "Senior Engineer" instead of "Claude Code".
//
// The registry is module-global mutable state, so we expose a tiny pub/sub
// surface (`subscribePersonaRegistry` + `getPersonaRegistryVersion`) wired up
// to React's `useSyncExternalStore` in `usePersonaRegistry()` below — when
// any caller updates the list, every component that read it re-renders with
// the new icons / labels. Without this, components mounted before the fetch
// would keep showing the Bot fallback or stale persona names.
interface PersonaRegEntry {
  base: string;
  name: string;
}
const personaRegistry: Map<string, PersonaRegEntry> = new Map();
let personaRegistryVersion = 0;
const personaRegistryListeners: Set<() => void> = new Set();

export function setCustomAgentPersonas(
  list: Array<{ id: string; name: string; base_agent: string }>,
): void {
  personaRegistry.clear();
  for (const p of list) {
    personaRegistry.set(p.id, { base: p.base_agent, name: p.name });
  }
  personaRegistryVersion += 1;
  for (const fn of personaRegistryListeners) fn();
}

// ─── Centralized persona fetcher ─────────────────────────────────────────
//
// Pages used to call `listCustomAgents()` independently and write into the
// registry — that race-conditioned: an in-flight stale fetch from page A
// could overwrite the fresh data page B just wrote (e.g. user creates a
// persona in Settings, navigates to Tasks, TaskChat's mount fetch resolves
// from a stale cache and clobbers the new entry).
//
// `loadCustomAgentPersonas` enforces latest-wins via `lastLoadSeq`: every
// caller still fires its own fetch, but only the most recent one writes
// into the registry. Stale resolutions return their data to the caller but
// don't clobber the shared state.
let lastLoadSeq = 0;

export async function loadCustomAgentPersonas<
  T extends { id: string; name: string; base_agent: string },
>(fetcher: () => Promise<T[]>): Promise<T[]> {
  const seq = ++lastLoadSeq;
  const list = await fetcher();
  if (seq === lastLoadSeq) {
    setCustomAgentPersonas(list);
  }
  return list;
}

export function subscribePersonaRegistry(listener: () => void): () => void {
  personaRegistryListeners.add(listener);
  return () => {
    personaRegistryListeners.delete(listener);
  };
}

export function getPersonaRegistryVersion(): number {
  return personaRegistryVersion;
}

/**
 * Resolve any agent key (value / id / icon_id / alias / persona id) to the row
 * that owns it. Returns a sentinel info object with `Component = Bot` for
 * unknown keys.
 *
 * Persona handling: if `key` matches a registered persona, the resolution
 * recurses with `persona.base_agent` so the icon/url come from the underlying
 * base; `label` is overridden to the persona's display name and
 * `canonicalKey` keeps the persona id.
 */
export function resolveAgentIcon(key: string | null | undefined): AgentIconInfo {
  if (!key) return { ...FALLBACK };
  const persona = personaRegistry.get(key);
  if (persona) {
    const base = resolveAgentIcon(persona.base);
    return {
      Component: base.Component,
      url: base.url,
      label: persona.name,
      canonicalKey: key,
    };
  }
  const row = TABLE_BY_KEY[key.toLowerCase()];
  if (!row) return { ...FALLBACK, label: key, canonicalKey: key };
  return {
    Component: row.Component ?? Bot,
    url: row.staticFile ? `/agent-icon/${row.staticFile}` : null,
    label: row.label,
    canonicalKey: row.key,
  };
}

/** Convenience for raw-DOM consumers: just the static URL or null. */
export function agentIconUrl(key: string | null | undefined): string | null {
  return resolveAgentIcon(key).url;
}

/** Convenience for React consumers that already have a key: returns the
 *  component to render. Always renderable (Bot fallback). */
export function agentIconComponent(
  key: string | null | undefined,
): ComponentType<{ size?: number; className?: string }> {
  return resolveAgentIcon(key).Component;
}

/**
 * Subscribe a React component to persona-registry changes. Returns the
 * registry version so React's `useSyncExternalStore` re-renders the caller
 * whenever `setCustomAgentPersonas` fires — e.g. after a new persona is
 * created in Settings, every list/icon consumer mounted on other pages picks
 * up the change without manual refetching.
 */
export function usePersonaRegistry(): number {
  return useSyncExternalStore(
    subscribePersonaRegistry,
    getPersonaRegistryVersion,
    getPersonaRegistryVersion,
  );
}
