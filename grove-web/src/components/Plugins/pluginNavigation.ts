import type { Plugin } from "../../api/plugins";
import { resolveSettingsTarget } from "../../orbit/settings/settingsModel";
import { pluginPageId } from "./pluginPages";

/**
 * `host.navigate` — the plugin bridge's navigation request.
 *
 * A plugin can open exactly two kinds of place:
 *   - `{ to: "plugin-page" }`         its OWN top-level page (`contributes.sidebar`);
 *   - `{ to: "settings", section? }`  Grove's Settings, optionally at a section.
 *
 * There is no way to name another plugin, an arbitrary page id or a URL: the
 * plugin id always comes from the frame hosting the request, and settings
 * sections are checked against the ids Settings actually resolves
 * (`resolveSettingsTarget`).
 */
export type PluginNavigateTarget =
  | { kind: "plugin-page"; pluginId: string; pageId: string }
  | { kind: "settings"; section: string | null };

export interface PluginBridgeError {
  code: string;
  message: string;
}

export type PluginNavigateResolution =
  | { ok: true; target: PluginNavigateTarget }
  | { ok: false; error: PluginBridgeError };

/** Validate a `host.navigate` request from `plugin`'s frame. */
export function resolvePluginNavigation(
  plugin: Pick<Plugin, "id" | "contributes">,
  params: Record<string, unknown>,
): PluginNavigateResolution {
  const to = params.to;
  if (to === "plugin-page") {
    if (!plugin.contributes?.sidebar) {
      return { ok: false, error: { code: "not_found", message: `plugin "${plugin.id}" has no page (declare contributes.sidebar)` } };
    }
    return { ok: true, target: { kind: "plugin-page", pluginId: plugin.id, pageId: pluginPageId(plugin.id) } };
  }
  if (to === "settings") {
    const section = params.section;
    if (section === undefined || section === null) return { ok: true, target: { kind: "settings", section: null } };
    if (typeof section !== "string" || !resolveSettingsTarget(section)) {
      return { ok: false, error: { code: "bad_request", message: `unknown settings section: ${String(section)}` } };
    }
    return { ok: true, target: { kind: "settings", section } };
  }
  return {
    ok: false,
    error: { code: "bad_request", message: `unknown navigation target: ${typeof to === "string" ? to : String(to)} (expected "plugin-page" or "settings")` },
  };
}

/** Window event the host shell (App) handles to perform a validated navigation. */
export const PLUGIN_NAVIGATE_EVENT = "grove:plugin-navigate";

export interface PluginNavigateDetail {
  target: PluginNavigateTarget;
  /** Set by the handler: true once it navigated, or an error explaining why not. */
  handled: boolean;
  error?: PluginBridgeError;
}

/**
 * Hand a validated target to the host shell and report the outcome. The shell's
 * listener runs synchronously inside dispatchEvent, so the result is known on
 * return; no listener (e.g. a surface without the app shell) is an error.
 */
export function dispatchPluginNavigation(target: PluginNavigateTarget): { ok: true } | { ok: false; error: PluginBridgeError } {
  const detail: PluginNavigateDetail = { target, handled: false };
  window.dispatchEvent(new CustomEvent<PluginNavigateDetail>(PLUGIN_NAVIGATE_EVENT, { detail }));
  if (detail.error) return { ok: false, error: detail.error };
  if (!detail.handled) return { ok: false, error: { code: "unavailable", message: "Grove can't navigate from this surface" } };
  return { ok: true };
}

/**
 * The shell's side: perform `detail.target` against the app's navigation state.
 * Re-checks the plugin page against the installed page list, since the frame's
 * plugin record may be stale.
 */
export function performPluginNavigation(
  detail: PluginNavigateDetail,
  deps: {
    pagePlugins: readonly Pick<Plugin, "id" | "contributes">[];
    orbit: boolean;
    setActiveItem: (item: string) => void;
    /** Open the Orbit settings page named by a `resolveSettingsTarget` id. */
    openSettingsSection: (section: string) => void;
  },
): void {
  const { target } = detail;
  if (target.kind === "plugin-page") {
    if (!deps.pagePlugins.some((plugin) => plugin.id === target.pluginId && plugin.contributes?.sidebar)) {
      detail.error = { code: "not_found", message: `plugin "${target.pluginId}" has no page in Grove` };
      return;
    }
    deps.setActiveItem(target.pageId);
    detail.handled = true;
    return;
  }
  deps.setActiveItem("settings");
  // Workbench Settings is one scrolling page with no deep links: it opens at the top.
  if (deps.orbit && target.section) deps.openSettingsSection(target.section);
  detail.handled = true;
}

/** A frame that isn't on screen (a background tab, a hidden page) may not navigate. */
export function isPluginFrameShown(iframe: HTMLIFrameElement | null): boolean {
  if (!iframe || !iframe.isConnected) return false;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  const check = (iframe as HTMLIFrameElement & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === "function" ? check.call(iframe) : true;
}
