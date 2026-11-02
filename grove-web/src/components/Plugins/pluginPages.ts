import type { Plugin } from "../../api/plugins";

/** Page-id prefix of a plugin's top-level page (`contributes.sidebar`). */
export const PLUGIN_PAGE_PREFIX = "plugin:";

/** A plugin's top-level page as a navigation entry. */
export interface PluginPageEntry {
  /** Page id, `plugin:<pluginId>`. */
  id: string;
  /** Sidebar title, falling back to the plugin's name. */
  label: string;
  plugin: Plugin;
}

export function pluginPageId(pluginId: string): string {
  return `${PLUGIN_PAGE_PREFIX}${pluginId}`;
}

/** The title a plugin's page shows: `contributes.sidebar.title`, else its name. */
export function pluginPageTitle(plugin: Pick<Plugin, "name" | "contributes">): string {
  return plugin.contributes?.sidebar?.title || plugin.name;
}

/** Plugins that contribute a top-level page, as navigation entries (install order). */
export function pluginPageEntries(plugins: readonly Plugin[] | undefined): PluginPageEntry[] {
  return (plugins ?? [])
    .filter((plugin) => plugin.contributes?.sidebar)
    .map((plugin) => ({ id: pluginPageId(plugin.id), label: pluginPageTitle(plugin), plugin }));
}

/** The plugin whose page `pageId` names, if it is installed. */
export function findPluginPage(plugins: readonly Plugin[] | undefined, pageId: string): Plugin | undefined {
  if (!pageId.startsWith(PLUGIN_PAGE_PREFIX)) return undefined;
  const id = pageId.slice(PLUGIN_PAGE_PREFIX.length);
  return (plugins ?? []).find((plugin) => plugin.id === id && plugin.contributes?.sidebar);
}
