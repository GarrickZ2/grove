import {
  Bell,
  FolderGit2,
  Keyboard,
  MonitorCog,
  Palette,
  SlidersHorizontal,
  Sparkle,
  type LucideIcon,
} from "lucide-react";
import type { PageHue } from "../ui";
import { VOICE_PAGE_META } from "./pages/voice/voicePages";

export type SettingsPageId =
  | "agents"
  | "worktrees"
  | "voice"
  | "vcontrol"
  | "avoice"
  | "providers"
  | "general"
  | "appearance"
  | "shortcuts"
  | "notifications"
  | "system";

export interface SettingsSub {
  id: string;
  label: string;
}

export interface SettingsPageDef {
  id: SettingsPageId;
  title: string;
  description: string;
  icon: LucideIcon;
  hue: PageHue;
  /** Nav items sharing a group number sit between the same separators. */
  group: number;
  subs: SettingsSub[];
  /** Extra search terms beyond the title and sub-section labels. */
  keywords: string[];
}

const VOICE_HUE: PageHue = { from: "#fda4af", to: "#be123c", glow: "rgba(225,29,72,.12)", strong: "rgba(190,18,60,.7)" };

export const SETTINGS_PAGES: SettingsPageDef[] = [
  {
    id: "agents",
    title: "Agents",
    description: "Choose the default coding agent, manage custom agents, and let agents use your browser.",
    icon: Sparkle,
    hue: { from: "#a78bfa", to: "#6d28d9", glow: "rgba(124,58,237,.16)", strong: "rgba(109,40,217,.7)" },
    group: 0,
    subs: [
      { id: "default", label: "Default agent" },
      { id: "manage", label: "Manage" },
      { id: "browser", label: "Browser control" },
      { id: "sending", label: "Sending" },
      { id: "history", label: "Chat history" },
      { id: "render", label: "Render window" },
    ],
    keywords: ["coding agent", "marketplace", "custom agents", "persona", "agent servers", "acp", "messages", "media", "tool calls", "browser control", "chrome", "companion", "extension", "tab groups", "browser automation", "web"],
  },
  {
    id: "general",
    title: "General",
    description: "Interface behavior and the apps Grove opens files with.",
    icon: SlidersHorizontal,
    hue: { from: "#a8a29e", to: "#57534e", glow: "rgba(120,113,108,.12)", strong: "rgba(87,83,78,.6)" },
    group: 1,
    subs: [
      { id: "apps", label: "Default apps" },
      { id: "window", label: "Window" },
      { id: "interface", label: "Interface" },
    ],
    keywords: ["ide", "editor", "terminal app", "interface", "orbit", "workbench", "workspace layout", "window shortcut"],
  },
  {
    id: "appearance",
    title: "Appearance",
    description: "Theme, color mode and app icon.",
    icon: Palette,
    hue: { from: "#f9a8d4", to: "#db2777", glow: "rgba(219,39,119,.14)", strong: "rgba(219,39,119,.7)" },
    group: 1,
    subs: [
      { id: "mode", label: "Mode" },
      { id: "light", label: "Light theme" },
      { id: "dark", label: "Dark theme" },
      { id: "custom", label: "Custom themes" },
      { id: "icon", label: "App icon" },
    ],
    keywords: ["theme", "dark", "light", "color mode", "app icon", "import theme"],
  },
  {
    id: "notifications",
    title: "Notifications",
    description: "When and where Grove tells you an agent needs you.",
    icon: Bell,
    hue: { from: "#fb923c", to: "#dc2626", glow: "rgba(239,68,68,.13)", strong: "rgba(220,38,38,.7)" },
    group: 1,
    subs: [
      { id: "channels", label: "Channels" },
      { id: "system", label: "System notifications" },
      { id: "menubar", label: "Menu bar" },
    ],
    keywords: ["sounds", "tray", "permission", "alerts", "retention", "done chats"],
  },
  {
    id: "shortcuts",
    title: "Keyboard Shortcuts",
    description: "View and rebind every keyboard shortcut.",
    icon: Keyboard,
    hue: { from: "#fcd34d", to: "#d97706", glow: "rgba(217,119,6,.14)", strong: "rgba(217,119,6,.7)" },
    group: 1,
    subs: [],
    keywords: ["keybindings", "hotkeys", "keymap", "conflicts", "reset"],
  },
  {
    // Terminal and worktree settings share a page: both shape the environment
    // a task runs in. The id stays "worktrees" so existing links keep working.
    id: "worktrees",
    title: "Workspace",
    description: "How task terminals run, and what every task worktree gets.",
    icon: FolderGit2,
    hue: { from: "#4ade80", to: "#15803d", glow: "rgba(22,163,74,.15)", strong: "rgba(21,128,61,.7)" },
    group: 2,
    subs: [
      { id: "mode", label: "Terminal" },
      { id: "layout", label: "Terminal layout" },
      { id: "autolink", label: "AutoLink" },
      { id: "indexing", label: "Code Indexing" },
    ],
    keywords: ["terminal", "tmux", "zellij", "multiplexer", "direct", "panes", "shell", "terminal agent", "worktree", "symlink", "glob", "node_modules", "patterns", "languages", "cmd+click", "navigation"],
  },
  {
    id: "voice",
    title: VOICE_PAGE_META.voice.title,
    description: VOICE_PAGE_META.voice.description,
    icon: VOICE_PAGE_META.voice.icon,
    hue: VOICE_HUE,
    group: 3,
    subs: VOICE_PAGE_META.voice.subs,
    keywords: VOICE_PAGE_META.voice.keywords,
  },
  {
    id: "vcontrol",
    title: VOICE_PAGE_META.vcontrol.title,
    description: VOICE_PAGE_META.vcontrol.description,
    icon: VOICE_PAGE_META.vcontrol.icon,
    hue: VOICE_HUE,
    group: 3,
    subs: VOICE_PAGE_META.vcontrol.subs,
    keywords: VOICE_PAGE_META.vcontrol.keywords,
  },
  {
    id: "avoice",
    title: VOICE_PAGE_META.avoice.title,
    description: VOICE_PAGE_META.avoice.description,
    icon: VOICE_PAGE_META.avoice.icon,
    hue: VOICE_HUE,
    group: 3,
    // "Voice character" only renders for some providers, so it stays out of the nav.
    subs: VOICE_PAGE_META.avoice.subs.filter((sub) => sub.id !== "character"),
    keywords: VOICE_PAGE_META.avoice.keywords,
  },
  {
    id: "providers",
    title: VOICE_PAGE_META.providers.title,
    description: VOICE_PAGE_META.providers.description,
    icon: VOICE_PAGE_META.providers.icon,
    hue: VOICE_HUE,
    group: 3,
    subs: VOICE_PAGE_META.providers.subs,
    keywords: VOICE_PAGE_META.providers.keywords,
  },
  {
    id: "system",
    title: "System",
    description: "Your machines, devices signed in to this Grove, and the resources it uses.",
    icon: MonitorCog,
    hue: { from: "#60a5fa", to: "#1d4ed8", glow: "rgba(37,99,235,.14)", strong: "rgba(29,78,216,.7)" },
    group: 4,
    subs: [
      { id: "machines", label: "Machines" },
      { id: "devices", label: "Login devices" },
      { id: "resources", label: "Resources" },
    ],
    keywords: ["machines", "servers", "multiple", "devices", "sign in", "cpu", "memory", "storage", "resource monitor"],
  },
];

export const DEFAULT_SETTINGS_PAGE: SettingsPageId = "agents";

export function isSettingsPageId(value: unknown): value is SettingsPageId {
  return typeof value === "string" && SETTINGS_PAGES.some((page) => page.id === value);
}

/** Workbench Settings section ids that moved in Orbit: Terminal merged into
 *  Workspace ("worktrees"), Browser Control folded into Agents. */
const LEGACY_SETTINGS_TARGETS: Record<string, { pageId: SettingsPageId; subId?: string }> = {
  terminal: { pageId: "worktrees", subId: "mode" },
  layout: { pageId: "worktrees", subId: "layout" },
  autolink: { pageId: "worktrees", subId: "autolink" },
  indexing: { pageId: "worktrees", subId: "indexing" },
  browserControl: { pageId: "agents", subId: "browser" },
  browser: { pageId: "agents", subId: "browser" },
  chat: { pageId: "agents" },
};

/** A settings link target (`#settings-<id>`): an Orbit page id, or a legacy
 *  Workbench section id mapped to where that section lives now. */
export function resolveSettingsTarget(id: string): { pageId: SettingsPageId; subId?: string } | null {
  if (isSettingsPageId(id)) return { pageId: id };
  return Object.prototype.hasOwnProperty.call(LEGACY_SETTINGS_TARGETS, id) ? LEGACY_SETTINGS_TARGETS[id] : null;
}

export interface SettingsSearchHit {
  pageId: SettingsPageId;
  /** Sub-section whose label matched, so Enter can jump straight to it. */
  subId?: string;
}

/**
 * Pages matching every whitespace-separated term of `query` (case-insensitive)
 * across title, sub-section labels and keywords. An empty query returns all.
 */
export function searchSettingsPages(pages: SettingsPageDef[], query: string): SettingsSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return pages.map((page) => ({ pageId: page.id }));
  const terms = needle.split(/\s+/);
  const hits: SettingsSearchHit[] = [];
  for (const page of pages) {
    const haystack = [page.title, ...page.subs.map((sub) => sub.label), ...page.keywords].join(" ").toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;
    const sub = page.title.toLowerCase().includes(needle)
      ? undefined
      : page.subs.find((candidate) => candidate.label.toLowerCase().includes(needle));
    hits.push(sub ? { pageId: page.id, subId: sub.id } : { pageId: page.id });
  }
  return hits;
}

/** Move a list cursor by `delta`, wrapping at both ends. */
export function moveCursor(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

export interface SectionAnchor {
  id: string;
  /** Offset of the anchor from the top of the scroll content. */
  top: number;
}

/** Distance below the top edge at which a section counts as "current". */
export const SCROLL_SPY_THRESHOLD = 120;

/**
 * Scroll-spy: the last section whose top has crossed the threshold line, or
 * the final section once the container is scrolled to the bottom.
 */
export function pickActiveSection(
  anchors: SectionAnchor[],
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): string | undefined {
  if (anchors.length === 0) return undefined;
  if (scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 2) return anchors[anchors.length - 1].id;
  let current = anchors[0].id;
  for (const anchor of anchors) {
    if (anchor.top - scrollTop <= SCROLL_SPY_THRESHOLD) current = anchor.id;
  }
  return current;
}

