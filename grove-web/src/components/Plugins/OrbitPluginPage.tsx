import type { Plugin } from "../../api/plugins";
import { PluginFrame } from "./PluginFrame";
import { PluginIcon } from "./PluginIcon";
import { pluginPageTitle } from "./pluginPages";
import "../../orbit/ui/orbit-ui.css";
import "./orbit-plugins.css";

/**
 * A plugin's top-level page (`contributes.sidebar`) in Orbit: the Orbit page
 * header (the plugin's icon, title and version) over the plugin's iframe,
 * edge to edge. Workbench renders the bare PluginFrame instead.
 */
export function OrbitPluginPage({ plugin, projectId }: { plugin: Plugin; projectId: string | null }) {
  const title = pluginPageTitle(plugin);
  const subtitle = [title !== plugin.name ? plugin.name : null, plugin.version ? `v${plugin.version}` : null, plugin.source === "dev" ? "Development" : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="oui-page orbit-ui oplg-page">
      <div className="oplg-page-inner">
        <header className="oui-page-head oui-rise oplg-head">
          <span className="oplg-glyph" aria-hidden="true">
            <PluginIcon plugin={plugin} className="oplg-glyph-icon" size={24} />
          </span>
          <div className="oui-page-head-copy">
            <div className="oui-page-title">
              <h1 className="oui-truncate" title={title}>{title}</h1>
            </div>
            {subtitle ? <p className="oui-truncate">{subtitle}</p> : null}
          </div>
        </header>
        <div className="oplg-body">
          <PluginFrame plugin={plugin} contribution="sidebar" projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
