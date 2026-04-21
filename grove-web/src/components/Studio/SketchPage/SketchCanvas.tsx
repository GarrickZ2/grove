import React, { Suspense, useRef } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

/**
 * Lazy-load Excalidraw along with a trimmed MainMenu. We render MainMenu
 * inside the Excalidraw tree so that a) its DefaultItems resolve against the
 * same lazy-loaded module, and b) the whole thing stays in the Excalidraw
 * code-split chunk — matching the `perf(sketch): lazy-load Excalidraw` intent.
 *
 * Items we keep: Export image, Find on canvas, Help, Dark mode, Canvas
 * background.
 * Items we drop: Open, Save to... (conflicts with Grove's own storage),
 * Reset the canvas (dangerous, one-click wipe), GitHub/Follow/Discord
 * (irrelevant to Grove users).
 */
interface LazyExcalidrawProps {
  initialData: unknown;
  excalidrawAPI: (api: ExcalidrawImperativeAPI) => void;
  onChange: (
    elements: readonly unknown[],
    appState: unknown,
    files: unknown,
  ) => void;
  /** When true, put Excalidraw in view-only mode (no edits). Used while the
   * ACP chat is busy so user edits don't race with AI-authored writes. */
  viewModeEnabled?: boolean;
}

const LazyExcalidraw = React.lazy(async () => {
  const m = await import("@excalidraw/excalidraw");
  const { Excalidraw, MainMenu, convertToExcalidrawElements } = m;
  const Wrapped: React.FC<LazyExcalidrawProps> = (props) => {
    // Expand shorthand elements (notably `label` on shapes) into the
    // fully-bound Excalidraw format (container + separate text element with
    // containerId). AI / MCP writes use the shorthand to save tokens; this
    // pass handles the conversion at load time.
    //
    // Element-by-element routing: only elements that actually carry the
    // `label` shorthand go through `convertToExcalidrawElements`; everything
    // else is handed to Excalidraw verbatim. Two reasons for the split:
    //
    // 1. The converter's `newArrowElement()` hardcodes
    //    `startBinding: null, endBinding: null` in its returned object,
    //    so any arrow that flows through it loses its `startBinding` /
    //    `endBinding` — regardless of whether that specific arrow had a
    //    `label`. Arrows are connective tissue in AI-generated diagrams;
    //    silently stripping their bindings means users drag a shape and
    //    the arrows detach.
    // 2. The converter also isn't idempotent on already-expanded text
    //    elements with `containerId` — re-running it on each load nudges
    //    label coordinates a few pixels, causing cumulative drift across
    //    reloads.
    //
    // Converter is called on a filtered subset only (shorthand-bearing
    // elements) and then we concat the pass-through set behind them so
    // z-order is preserved.
    //
    // Excalidraw only reads `initialData` on first mount — use a lazy
    // `useState` initializer so this runs exactly once per mount.
    const [transformed] = React.useState<
      { elements: unknown[]; appState?: unknown; files?: unknown } | undefined
    >(() => {
      if (!props.initialData) return undefined;
      const data = props.initialData as {
        elements?: unknown[];
        appState?: unknown;
        files?: unknown;
      };
      const raw = (data.elements ?? []) as unknown[];
      if (!Array.isArray(raw) || raw.length === 0) {
        return { ...data, elements: raw };
      }
      const hasShorthand = (el: unknown): boolean =>
        !!el && typeof el === "object" && "label" in (el as object);
      const anyShorthand = raw.some(hasShorthand);
      if (!anyShorthand) {
        return { ...data, elements: raw };
      }
      // Convert only the shorthand-bearing elements; pass all others
      // through unchanged. Preserve original order so z-order stays
      // correct.
      const result: unknown[] = [];
      for (const el of raw) {
        if (hasShorthand(el)) {
          const converted = convertToExcalidrawElements(
            [el] as Parameters<typeof convertToExcalidrawElements>[0],
            { regenerateIds: false },
          );
          result.push(...converted);
        } else {
          result.push(el);
        }
      }
      return { ...data, elements: result };
    });
    const { initialData: _omit, ...rest } = props;
    void _omit;
    return (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <Excalidraw {...(rest as any)} initialData={transformed}>
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    );
  };
  return { default: Wrapped };
});

interface Props {
  scene: unknown | null;
  onChange: (next: unknown) => void;
  onExcalidrawAPI?: (api: ExcalidrawImperativeAPI) => void;
  /** When true, lock the canvas (read-only). Surfaced while the ACP chat is
   * busy so the user can't edit concurrently with AI-authored writes
   * (which would otherwise overwrite each other at save time). */
  locked?: boolean;
}

interface ExcalidrawScene {
  elements?: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

/**
 * Sanitize an appState that came from disk / WebSocket: JSON round-trips strip
 * the `Map` prototype off `collaborators`, which Excalidraw then tries to call
 * `.forEach` on at render time (crashing). Drop the key so Excalidraw's default
 * (an empty Map) is used. Also drop fields that hold transient per-session
 * state we do not want to restore across reloads (selection, in-flight edits).
 */
function sanitizeAppState(
  appState: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const clean: Record<string, unknown> = appState ? { ...appState } : {};
  delete clean.cursorButton;
  // Transient per-session state — persisting these makes every element appear
  // selected when the sketch is reopened, and breaks in-progress edits on
  // mount. Reset to empty.
  clean.selectedElementIds = {};
  clean.selectedGroupIds = {};
  clean.selectedLinearElement = null;
  clean.editingLinearElement = null;
  clean.editingTextElement = null;
  clean.editingGroupId = null;
  // Excalidraw expects a Map; explicitly set an empty Map so merges do not
  // leave a plain-object `{}` collaborators in place.
  clean.collaborators = new Map();
  return clean;
}

export function SketchCanvas({
  scene,
  onChange,
  onExcalidrawAPI,
  locked,
}: Props) {
  // Remote-driven updates are surfaced via key-based remount in the parent
  // (SketchPage); nothing to track here.
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  const initial = scene as ExcalidrawScene | null;
  return (
    <div className="w-full h-full">
      <Suspense
        fallback={
          <div
            className="flex items-center justify-center h-full text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            Loading canvas…
          </div>
        }
      >
        <LazyExcalidraw
          initialData={
            initial
              ? {
                  elements: initial.elements ?? [],
                  appState: sanitizeAppState(initial.appState),
                  files: initial.files ?? {},
                }
              : undefined
          }
          excalidrawAPI={(api) => {
            apiRef.current = api;
            onExcalidrawAPI?.(api);
          }}
          onChange={(elements, appState, files) => {
            onChange({
              type: "excalidraw",
              version: 2,
              source: "grove",
              elements,
              appState,
              files,
            });
          }}
          viewModeEnabled={locked}
        />
      </Suspense>
    </div>
  );
}
