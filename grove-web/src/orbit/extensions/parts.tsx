import type { CSSProperties } from "react";
import type { ExtensionArtifact } from "../../api/extensions";
import type { Plugin } from "../../api/plugins";
import { AgentIcon } from "../../components/Skills/AgentIcon";
import { BuddyAvatar } from "../../components/Buddy/BuddyAvatar";
import { PluginIcon } from "../../components/Plugins/PluginIcon";
import { manifestIcon } from "../../components/Skills/manifestIcon";
import { identityHue } from "./catalogModel";

/* Identity marks only the Extensions page draws (shared controls live in ../ui). */

/** Identity tile: the plugin's or manifest's own icon when it has one,
 *  otherwise a tinted tile with the initial. */
export function ExtIcon({ kind, name, manifest, plugin, large = false }: {
  kind: ExtensionArtifact["kind"];
  name: string;
  manifest?: Record<string, unknown> | null;
  plugin?: Plugin;
  large?: boolean;
}) {
  const hue = identityHue(`${kind}:${name}`);
  const style = { "--oex-a": hue.from, "--oex-b": hue.to } as CSSProperties;
  const className = `oex-eicon${large ? " is-lg" : ""}`;
  if (kind === "plugin" && plugin?.icon) {
    return <span className={`${className} is-own`} style={style} aria-hidden="true"><PluginIcon plugin={plugin} className={large ? "h-6 w-6" : "h-4 w-4"} size={large ? 24 : 16} /></span>;
  }
  const icon = manifestIcon(manifest);
  if (icon && /^(https?:|data:)/i.test(icon)) {
    return <span className={`${className} is-own`} style={style} aria-hidden="true"><img src={icon} alt="" /></span>;
  }
  if (icon && !icon.includes("/") && !/\.(png|svg|jpe?g|gif|webp|ico)$/i.test(icon)) {
    return <span className={`${className} is-own is-emoji`} style={style} aria-hidden="true">{icon}</span>;
  }
  return <span className={className} style={style} aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "?"}</span>;
}

export interface MarkTarget {
  id: string;
  name: string;
  iconId?: string | null;
  buddy?: { buddyId: string; avatar: string | null };
}

/** Small agent / Buddy mark for stacks and chips. */
export function AgentMark({ target, size = 18 }: { target: MarkTarget; size?: number }) {
  return (
    <span className="oex-amark" style={{ width: size, height: size }} title={target.name}>
      {target.buddy
        ? <BuddyAvatar id={target.buddy.buddyId} avatar={target.buddy.avatar} size={size - 2} />
        : <AgentIcon iconId={target.iconId ?? target.id} size={Math.round(size * 0.72)} />}
    </span>
  );
}
