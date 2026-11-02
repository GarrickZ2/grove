import type { Theme, ThemeColors } from "../../context/ThemeContext";
// The `.orbit-ui` token rule must exist for the probe below, even in Workbench.
import "../../orbit/tokens.css";

/**
 * The theme payload the plugin bridge sends: the `theme.get` reply and the
 * `grove:theme` push.
 *
 * `id` / `isLight` / `colors` are the original fields and never change shape,
 * so SDKs vendored before `interface` and `tokens` existed keep working (they
 * ignore the extra keys). SDKs that know the new keys treat a missing
 * `interface` as "workbench" and missing `tokens` as "derive them yourself".
 */
export type PluginInterface = "orbit" | "workbench";

export interface PluginThemePayload {
  id: string;
  isLight: boolean;
  colors: ThemeColors;
  /** Which interface Grove is showing. */
  interface: PluginInterface;
  /** Orbit design tokens resolved against the live document, keyed by their
   *  CSS name (`"--o-bg"`, `"--o-radius"`, ...). Sent under both interfaces:
   *  the values derive from the active theme, so a plugin styled with them
   *  looks right in Workbench too. */
  tokens: Record<string, string>;
}

/** Every `--o-*` token in `orbit/tokens.css`. */
export const ORBIT_TOKEN_NAMES = [
  // Colour
  "--o-bg", "--o-text", "--o-muted", "--o-border", "--o-border-strong",
  "--o-hover", "--o-selected", "--o-group", "--o-track", "--o-code", "--o-frost",
  "--o-accent", "--o-accent-soft", "--o-success", "--o-warn", "--o-error", "--o-info",
  "--o-ink", "--o-on-ink", "--o-on-accent",
  // Elevation
  "--o-shadow", "--o-shadow-1", "--o-shadow-2", "--o-ring-selected",
  // Radii
  "--o-radius-xs", "--o-radius-sm", "--o-radius", "--o-radius-md", "--o-radius-lg",
  // Type
  "--o-font-sans", "--o-font-mono",
  // Motion
  "--o-ease-slide", "--o-ease-toggle", "--o-ease-out", "--o-ease-pop", "--o-ease-draw", "--o-ease-reflow",
  "--o-dur-fast", "--o-dur-slide", "--o-dur-toggle", "--o-dur-enter", "--o-dur-pop", "--o-dur-condense",
  "--o-dur-reflow", "--o-stagger",
] as const;

let probe: HTMLElement | null = null;

/** A hidden `.orbit-ui` element under <body>: it inherits the live theme
 *  variables from :root and gets the token rule, in either interface. */
function tokenProbe(): HTMLElement {
  if (!probe || !probe.isConnected) {
    probe = document.createElement("div");
    probe.className = "orbit-ui";
    probe.hidden = true;
    probe.setAttribute("aria-hidden", "true");
    probe.dataset.grovePluginTokenProbe = "";
    document.body.appendChild(probe);
  }
  return probe;
}

/**
 * Read the Orbit tokens from the live document. Each value has its `var()`
 * references substituted, so it stands alone inside the plugin's iframe
 * (colour values may still be `color-mix(...)` expressions, which every
 * engine Grove runs on supports). Empty values are left out.
 */
export function readOrbitTokens(read?: (name: string) => string): Record<string, string> {
  let get = read;
  if (!get) {
    if (typeof document === "undefined" || !document.body) return {};
    const style = getComputedStyle(tokenProbe());
    get = (name) => style.getPropertyValue(name);
  }
  const tokens: Record<string, string> = {};
  for (const name of ORBIT_TOKEN_NAMES) {
    const value = get(name)?.trim();
    if (value) tokens[name] = value;
  }
  return tokens;
}

export function buildPluginThemePayload(
  theme: Pick<Theme, "id" | "isLight" | "colors">,
  orbit: boolean,
  tokens: Record<string, string> = readOrbitTokens(),
): PluginThemePayload {
  return {
    id: theme.id,
    isLight: theme.isLight,
    colors: theme.colors,
    interface: orbit ? "orbit" : "workbench",
    tokens,
  };
}
