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

import { createElement, useSyncExternalStore, type ComponentType } from "react";
import { Bot } from "lucide-react";
import {
  Claude,
  Gemini,
  Copilot,
  Cursor,
  Trae,
  TraeX,
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
    aliases: ["claude-code", "claude-acp", "claude-color", "claude code", "claude-agent-acp", "claude-code-acp", "@agentclientprotocol/claude-agent-acp"],
  },
  {
    key: "codex",
    label: "CodeX",
    staticFile: "openai.svg",
    Component: OpenAI,
    aliases: ["openai", "codex-acp", "@zed-industries/codex-acp"],
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
    aliases: ["gh-copilot", "githubcopilot", "github copilot", "github-copilot-cli"],
  },
  {
    key: "hermes",
    label: "Hermes",
    staticFile: "hermes.svg",
    Component: Hermes,
    aliases: ["hermes acp"],
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
    aliases: ["kiro-cli", "kiro-cli acp"],
  },
  {
    key: "openclaw",
    label: "OpenClaw",
    staticFile: "openclaw-color.svg",
    Component: OpenClaw.Color,
    aliases: ["openclaw-color", "openclaw acp"],
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
    aliases: ["qwen-color", "qwen-code"],
  },
  {
    key: "traecli",
    label: "Trae",
    staticFile: "trae-color.svg",
    Component: Trae.Color,
    aliases: ["trae", "trae-color"],
  },
  {
    // TraeX — distinct monochrome icon (traex.svg) and label.
    // Own row so `resolveAgentIcon("traex").label` returns "TraeX".
    key: "traex",
    label: "TraeX",
    staticFile: "traex.svg",
    Component: TraeX,
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

// Brand words to scan for when an exact key lookup misses. ACP agents self-report
// a display name over the `initialize` handshake (`agent_info.name`, e.g. "Claude
// Agent", "Gemini CLI") that flows through to review-comment author fields and other
// UI — those names are their own naming space and rarely equal our canonical keys,
// so exact lookup Bot-fallbacks on perfectly recognizable agents. The name almost
// always still *contains* the brand word, so a contained-substring pass recovers it.
// Longest-first so "opencode"/"openclaw" win before a bare "open"-style prefix, and
// the words are distinctive enough that false positives aren't a real concern.
const BRAND_MATCHERS: Array<{ needle: string; key: string }> = [
  { needle: "opencode", key: "opencode" },
  { needle: "openclaw", key: "openclaw" },
  { needle: "copilot", key: "copilot" },
  { needle: "windsurf", key: "windsurf" },
  { needle: "claude", key: "claude" },
  { needle: "gemini", key: "gemini" },
  { needle: "cursor", key: "cursor" },
  { needle: "codex", key: "codex" },
  { needle: "hermes", key: "hermes" },
  { needle: "junie", key: "junie" },
  { needle: "qwen", key: "qwen" },
  { needle: "kimi", key: "kimi" },
  { needle: "kiro", key: "kiro" },
  { needle: "traex", key: "traex" },
  { needle: "trae", key: "traecli" },
];

function fuzzyBrandRow(key: string): AgentRow | undefined {
  const lower = key.toLowerCase();
  for (const { needle, key: rowKey } of BRAND_MATCHERS) {
    if (lower.includes(needle)) return TABLE_BY_KEY[rowKey];
  }
  return undefined;
}

const FALLBACK: AgentIconInfo = {
  Component: Bot,
  url: null,
  label: "",
  canonicalKey: "",
};

// ─── Marketplace icon registry (CDN-served fallback) ─────────────────────────
//
// When no bundled brand icon matches, we fall back to whatever the agent's
// Marketplace registry entry advertised. Surfaces that fetch the marketplace
// (MarketplaceModal, useACPAvailability, App config validator) call
// `setMarketplaceIcons` to refresh this map; resolveAgentIcon then consumes
// it transparently so consumers everywhere keep using a single util.
//
// Priority is fixed:  bundled brand SVG  >  marketplace icon_url  >  Bot.
const marketplaceIcons: Map<string, string> = new Map();

/** Wrap a CDN URL as a React component matching the {size, className} contract
 *  the rest of the icon system uses. Returned components are stable per URL
 *  (memoized below) so React doesn't see a fresh fn each render. */
const imageComponentCache: Map<string, ComponentType<{ size?: number; className?: string }>> =
  new Map();

function getImageComponent(url: string): ComponentType<{ size?: number; className?: string }> {
  const cached = imageComponentCache.get(url);
  if (cached) return cached;
  const Comp: ComponentType<{ size?: number; className?: string }> = ({ size, className }) =>
    createElement("img", {
      src: url,
      alt: "",
      width: size,
      height: size,
      style: { width: size, height: size },
      className,
      // NOT `loading="lazy"`. These icons are tiny (~20px) and live inside
      // modals / popovers that animate in — the browser's lazy-load
      // viewport detection misses them and the image never paints until
      // the user scrolls or resizes, manifesting as "icon takes many
      // refreshes to show". Eager load is the correct fit.
    });
  imageComponentCache.set(url, Comp);
  return Comp;
}

/** Bulk-update the marketplace icon map. Fire whenever marketplace data
 *  is fetched.
 *
 *  Merge semantics (not clear-and-rebuild):
 *    - Empty `entries` → no-op. A fail-open / loading code path would
 *      otherwise erase every CDN icon until the next successful call.
 *    - Entry with a non-null `icon_url` → upsert.
 *    - Entry with an explicit `null` `icon_url` → DELETE the stored URL.
 *      Lets upstream registry retire an icon without leaving a stale
 *      URL pinned forever. */
export function setMarketplaceIcons(
  entries: Array<{ id: string; icon_url: string | null }>,
): void {
  if (entries.length === 0) return;
  let changed = false;
  for (const e of entries) {
    if (e.icon_url) {
      if (marketplaceIcons.get(e.id) !== e.icon_url) {
        marketplaceIcons.set(e.id, e.icon_url);
        changed = true;
      }
    } else if (marketplaceIcons.delete(e.id)) {
      changed = true;
    }
  }
  if (!changed) return;
  personaRegistryVersion += 1; // reuse the same React subscription bus
  for (const fn of personaRegistryListeners) fn();
}

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
  if (row) {
    return {
      Component: row.Component ?? Bot,
      url: row.staticFile ? `/agent-icon/${row.staticFile}` : null,
      label: row.label,
      canonicalKey: row.key,
    };
  }
  // No bundled brand icon → fall back to whatever the marketplace CDN
  // shipped for this id (if anything). Centralized here so every consumer
  // (chat list, Open Sessions, Marketplace modal, agent picker) gets the
  // same priority: local bundle > marketplace CDN > Bot.
  const cdnUrl = marketplaceIcons.get(key);
  if (cdnUrl) {
    return {
      Component: getImageComponent(cdnUrl),
      url: cdnUrl,
      label: key,
      canonicalKey: key,
    };
  }
  // Last resort before Bot: recover a brand icon from a self-reported ACP display
  // name (e.g. "Claude Agent" → claude). Runs only here, so it strictly upgrades the
  // Bot fallback and can never override an exact-key or marketplace match above.
  // Keep the caller's `key` as label/canonicalKey — only the icon is borrowed.
  const brandRow = fuzzyBrandRow(key);
  if (brandRow) {
    return {
      Component: brandRow.Component ?? Bot,
      url: brandRow.staticFile ? `/agent-icon/${brandRow.staticFile}` : null,
      label: key,
      canonicalKey: key,
    };
  }
  return { ...FALLBACK, label: key, canonicalKey: key };
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
