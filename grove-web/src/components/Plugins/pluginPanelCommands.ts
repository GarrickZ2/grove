import { useEffect } from "react";
import { commandRegistry } from "../../keyboard";
import { listActivePlugins, PLUGINS_CHANGED_EVENT } from "../../api/plugins";

/** Fired (with the current task context) when a plugin's keybinding is pressed;
 *  the active layout opens that plugin's panel. */
export const OPEN_PLUGIN_PANEL_EVENT = "grove:open-plugin-panel";
export interface OpenPluginPanelDetail {
  projectId: string;
  taskId: string;
  pluginId: string;
}

/** Fired after a plugin is installed/uninstalled so open workspaces re-sync
 *  their plugin lists + keybindings live (no remount needed). */
export { PLUGINS_CHANGED_EVENT } from "../../api/plugins";

/** The keymap command id for opening a plugin's panel — matches the
 *  `panel.<key>.open` convention the toolbar's shortcut hints resolve. */
export function pluginPanelCommandId(pluginId: string): string {
  return `panel.plugin:${pluginId}.open`;
}

/**
 * Register a keymap command per panel-contributing plugin while a task
 * workspace is mounted. Each command:
 *   - carries the plugin's optional `shortcut` as its default binding,
 *   - is user-reconfigurable in Settings (runtime commands show there),
 *   - opens the plugin's panel when triggered (via OPEN_PLUGIN_PANEL_EVENT).
 * Commands are disposed on unmount and re-registered when the installed set
 * changes (PLUGINS_CHANGED_EVENT) — so install/uninstall add/remove them live.
 */
export function usePluginPanelCommands(projectId: string, taskId: string): void {
  useEffect(() => {
    let cancelled = false;
    let disposers: Array<() => void> = [];

    const register = async () => {
      disposers.forEach((d) => d());
      disposers = [];
      let plugins;
      try {
        plugins = await listActivePlugins();
      } catch {
        return;
      }
      if (cancelled) return;
      for (const p of plugins) {
        if (!p.contributes?.panel) continue;
        const title = p.contributes.panel.title || p.name;
        const key = p.contributes.panel.shortcut;
        const dispose = commandRegistry.contribute(
          {
            id: pluginPanelCommandId(p.id),
            name: `Open ${title} Panel`,
            category: "Plugins",
            defaultBindings: key ? [{ key }] : [],
            scope: "workspace",
            defaultWhen: "inWorkspace",
          },
          () => {
            window.dispatchEvent(
              new CustomEvent<OpenPluginPanelDetail>(OPEN_PLUGIN_PANEL_EVENT, {
                detail: { projectId, taskId, pluginId: p.id },
              }),
            );
          },
        );
        disposers.push(dispose);
      }
    };

    void register();
    const onChanged = () => {
      void register();
    };
    window.addEventListener(PLUGINS_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(PLUGINS_CHANGED_EVENT, onChanged);
      disposers.forEach((d) => d());
    };
  }, [projectId, taskId]);
}
