// Single source of truth for workspace panels — shared by BOTH layout modes
// (FlexLayout free tabs + IDE Layout fixed columns). Each panel is described
// once here: its metadata (label/icon/color/category/availability) and how to
// render it. Both layouts derive their menus from this catalog and render
// content via `renderPanel`, so adding a panel (or a plugin panel) is a
// one-place change and the two layouts can never drift apart again.
//
// The ONE thing not unified is layout *structure* (draggable tabs vs fixed
// columns) — that's the intentional difference between the two modes. Terminal
// also renders differently per layout (per-tab TaskTerminal vs a multi-tab
// slot), so the layout injects it via `ctx.renderTerminal`.

import type { CSSProperties, ElementType, ReactNode } from "react";
import {
  Terminal, MessageSquare, Code, FileCode, BarChart3, GitBranch, FileText,
  MessageCircle, FolderOpen, Pencil, Network,
} from "lucide-react";
import type { Task } from "../../../data/types";
import type { FileNavRequest } from "../../Review";
import type { Plugin } from "../../../api/plugins";
import { PluginIcon } from "../../Plugins/PluginIcon";
import { TaskChat } from "../TaskView/TaskChat";
import { OptionalPerfProfiler } from "../../../perf/profilerShim";
import { TaskCodeReview } from "../TaskView/TaskCodeReview";
import { TaskEditor } from "../TaskView/TaskEditor";
import { TaskGraph } from "../TaskView/TaskGraph";
import { StatsTab, GitTab, NotesTab, CommentsTab, ArtifactsTab } from "../TaskInfoPanel/tabs";
import type { ArtifactPreviewRequest } from "../TaskInfoPanel/tabs";
import { SketchPage } from "../../Studio/SketchPage";
import { PluginFrame } from "../../Plugins/PluginFrame";
import { commandRegistry, userKeymapStore, effectiveBindings, formatKeyDisplay } from "../../../keyboard";

/** The real keybinding display for a panel's `panel.<key>.open` command,
 *  resolved from the live keymap (static catalog + runtime plugin commands +
 *  the user's overrides) — never a hardcoded guess. Returns undefined when the
 *  panel has no command/binding. Callers should subscribe to commandRegistry +
 *  userKeymapStore so hints update live. */
export function panelShortcutDisplay(panelKey: string): string | undefined {
  const cmd = commandRegistry.listCommands().find((c) => c.id === `panel.${panelKey}.open`);
  if (!cmd) return undefined;
  const b = effectiveBindings(cmd, userKeymapStore.getAllOverrides().get(cmd.id))[0];
  return b ? formatKeyDisplay(b.key) : undefined;
}

/** Where a panel belongs. FlexLayout treats all as tabs; IDE Layout routes
 *  `aux` → left column, `info` → right column, `chat` → center. */
export type PanelCategory = "aux" | "info" | "chat";

/** Everything a panel's render() might need, supplied by whichever layout is
 *  hosting it. Layout-specific bits (onClose semantics, terminal node) are
 *  passed in so the render logic itself stays layout-agnostic. */
export interface PanelRenderCtx {
  projectId: string;
  task: Task;
  isStudio: boolean;
  isGitRepo?: boolean;
  terminalAvailable: boolean;
  /** Close/hide this panel — delete-tab in FlexLayout, hide-column in IDE. */
  onClose: () => void;
  /** Chat: navigate the editor/review to a file. */
  navigateToFile?: (filePath: string, line?: number, mode?: "diff" | "full") => Promise<boolean>;
  /** Review: a pending file-navigation request object. */
  fileNavRequest?: FileNavRequest | null;
  artifactPreviewRequest?: ArtifactPreviewRequest | null;
  lastChatIdleAt?: number;
  isChatBusy?: boolean;
  onChatBecameIdle?: () => void;
  onUserMessageSent?: () => void;
  onBusyStateChange?: (busy: boolean) => void;
  /** Terminal renders differently per layout — the host injects its node. */
  renderTerminal?: () => ReactNode;
  /** Installed plugins (for resolving `plugin:<id>` keys). */
  plugins?: Plugin[];
}

/** How FlexLayout wraps the panel's content inside its tab: `fill` (flex,
 *  no scroll), `scroll` (padded, scrolls — info panels), `hidden` (overflow
 *  clipped — canvas-y panels). IDE Layout ignores this (uses PanelSlot + CSS). */
export type FlexWrap = "fill" | "scroll" | "hidden";

export interface PanelDescriptor {
  key: string;
  label: string;
  icon: ElementType;
  /** CSS var for the tab icon tint (FlexLayout). */
  color: string;
  category: PanelCategory;
  /** Whether this panel applies to the current task/project. */
  available: (ctx: { isStudio: boolean; terminalAvailable: boolean }) => boolean;
  render: (ctx: PanelRenderCtx) => ReactNode;
}

// FlexLayout tab content wrapping (IDE Layout uses PanelSlot + CSS instead).
const FLEX_SCROLL = new Set(["stats", "git", "notes", "comments"]);
const FLEX_HIDDEN = new Set(["graph", "artifacts", "sketch"]);

/** The FlexLayout tab content wrapper style for a panel key. */
export function flexWrapStyle(key: string): CSSProperties {
  const base: CSSProperties = { display: "flex", flexDirection: "column", width: "100%", height: "100%" };
  if (FLEX_SCROLL.has(key)) return { ...base, padding: "16px", overflow: "auto" };
  if (FLEX_HIDDEN.has(key)) return { ...base, overflow: "hidden" };
  return base;
}

const always = () => true;

/** Built-in panels — the single catalog both layouts read from. */
export const BUILT_IN_PANELS: PanelDescriptor[] = [
  {
    key: "chat",
    label: "Chat",
    icon: MessageSquare,
    color: "var(--color-info)",
    category: "chat",
    available: always,
    render: (ctx) => (
      <OptionalPerfProfiler id="TaskChat">
        <TaskChat
          key={`${ctx.projectId}:${ctx.task.id}`}
          projectId={ctx.projectId}
          taskId={ctx.task.id}
          finished={ctx.task.status === "archived"}
          fullscreen
          onNavigateToFile={ctx.navigateToFile}
          onChatBecameIdle={ctx.onChatBecameIdle}
          onUserMessageSent={ctx.onUserMessageSent}
          onBusyStateChange={ctx.onBusyStateChange}
        />
      </OptionalPerfProfiler>
    ),
  },
  {
    key: "terminal",
    label: "Terminal",
    icon: Terminal,
    color: "var(--color-success)",
    category: "aux",
    available: (c) => c.terminalAvailable,
    render: (ctx) => ctx.renderTerminal?.() ?? null,
  },
  {
    key: "review",
    label: "Code Review",
    icon: Code,
    color: "var(--color-highlight)",
    category: "aux",
    available: (c) => !c.isStudio,
    render: (ctx) => (
      <TaskCodeReview
        projectId={ctx.projectId}
        taskId={ctx.task.id}
        navigateToFile={ctx.fileNavRequest ?? null}
        hideHeader
        fullscreen
        isGitRepo={ctx.isGitRepo}
        onClose={ctx.onClose}
        isChatBusy={ctx.isChatBusy}
      />
    ),
  },
  {
    key: "editor",
    label: "Editor",
    icon: FileCode,
    color: "var(--color-warning)",
    category: "aux",
    available: always,
    render: (ctx) => (
      <TaskEditor
        projectId={ctx.projectId}
        taskId={ctx.task.id}
        hideHeader
        fullscreen
        onClose={ctx.onClose}
      />
    ),
  },
  {
    key: "graph",
    label: "Graph",
    icon: Network,
    color: "var(--color-accent)",
    category: "aux",
    available: always,
    render: (ctx) => <TaskGraph projectId={ctx.projectId} taskId={ctx.task.id} />,
  },
  {
    key: "artifacts",
    label: "Artifacts",
    icon: FolderOpen,
    color: "var(--color-highlight)",
    category: "aux",
    available: (c) => c.isStudio,
    render: (ctx) => (
      <ArtifactsTab
        projectId={ctx.projectId}
        task={ctx.task}
        previewRequest={ctx.artifactPreviewRequest ?? null}
        lastChatIdleAt={ctx.lastChatIdleAt}
        isChatBusy={ctx.isChatBusy}
      />
    ),
  },
  {
    key: "sketch",
    label: "Sketch",
    icon: Pencil,
    color: "var(--color-accent)",
    category: "aux",
    available: (c) => c.isStudio,
    render: (ctx) => (
      <SketchPage
        projectId={ctx.projectId}
        taskId={ctx.task.id}
        isChatBusy={ctx.isChatBusy}
        lastChatIdleAt={ctx.lastChatIdleAt}
      />
    ),
  },
  {
    key: "stats",
    label: "Info",
    icon: BarChart3,
    color: "var(--color-accent)",
    category: "info",
    available: always,
    render: (ctx) => <StatsTab projectId={ctx.projectId} task={ctx.task} />,
  },
  {
    key: "git",
    label: "Git",
    icon: GitBranch,
    color: "var(--color-success)",
    category: "info",
    available: (c) => !c.isStudio,
    render: (ctx) => <GitTab projectId={ctx.projectId} task={ctx.task} />,
  },
  {
    key: "notes",
    label: "Notes",
    icon: FileText,
    color: "var(--color-info)",
    category: "info",
    available: always,
    render: (ctx) => <NotesTab projectId={ctx.projectId} task={ctx.task} />,
  },
  {
    key: "comments",
    label: "Comments",
    icon: MessageCircle,
    color: "var(--color-error)",
    category: "info",
    available: (c) => !c.isStudio,
    render: (ctx) => <CommentsTab projectId={ctx.projectId} task={ctx.task} />,
  },
];

const BUILT_IN_BY_KEY: Record<string, PanelDescriptor> = Object.fromEntries(
  BUILT_IN_PANELS.map((p) => [p.key, p]),
);

/** Prefix marking a plugin panel key: `plugin:<id>`. */
export const PLUGIN_PANEL_PREFIX = "plugin:";

/** Build a descriptor for a plugin panel. The plugin chooses which column it
 *  mounts in via `contributes.panel.side` ("right" → info column, default
 *  "left" → aux column). In FlexLayout (free tabs) `side` is moot. */
function pluginDescriptor(plugin: Plugin): PanelDescriptor {
  const side = plugin.contributes?.panel?.side;
  return {
    key: `${PLUGIN_PANEL_PREFIX}${plugin.id}`,
    label: plugin.contributes?.panel?.title || plugin.name,
    // The plugin's own icon (image/emoji), falling back to a puzzle glyph.
    icon: (props: { className?: string }) => (
      <PluginIcon plugin={plugin} className={props.className} size={16} />
    ),
    color: "var(--color-highlight)",
    category: side === "right" ? "info" : "aux",
    available: always,
    render: (ctx) => (
      <PluginFrame
        plugin={plugin}
        contribution="panel"
        projectId={ctx.projectId}
        taskId={ctx.task.id}
      />
    ),
  };
}

/** The full catalog for the current task: built-ins + installed panel plugins,
 *  filtered to those available for this project type. */
export function buildPanelCatalog(
  plugins: Plugin[] | undefined,
  filter: { isStudio: boolean; terminalAvailable: boolean },
): PanelDescriptor[] {
  const pluginPanels = (plugins ?? [])
    .filter((p) => p.contributes?.panel)
    .map(pluginDescriptor);
  return [...BUILT_IN_PANELS, ...pluginPanels].filter((p) => p.available(filter));
}

/** Resolve a panel key (built-in or `plugin:<id>`) to its descriptor. */
export function getPanelDescriptor(
  key: string,
  plugins?: Plugin[],
): PanelDescriptor | undefined {
  if (key.startsWith(PLUGIN_PANEL_PREFIX)) {
    const id = key.slice(PLUGIN_PANEL_PREFIX.length);
    const plugin = (plugins ?? []).find((p) => p.id === id);
    return plugin ? pluginDescriptor(plugin) : undefined;
  }
  return BUILT_IN_BY_KEY[key];
}

/** Render a panel's content by key. Returns a "not available" placeholder for
 *  an unknown/uninstalled key (e.g. a plugin removed while its tab persisted). */
export function renderPanel(key: string, ctx: PanelRenderCtx): ReactNode {
  const descriptor = getPanelDescriptor(key, ctx.plugins);
  if (!descriptor) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4 text-center text-xs text-[var(--color-text-muted)]">
        This panel is no longer available.
      </div>
    );
  }
  return descriptor.render(ctx);
}
