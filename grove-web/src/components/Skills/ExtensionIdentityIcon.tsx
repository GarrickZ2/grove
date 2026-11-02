import Avatar from "boring-avatars";
import type { ExtensionArtifact } from "../../api";
import type { Plugin } from "../../api/plugins";
import { PluginIcon } from "../Plugins/PluginIcon";
import { manifestIcon } from "./manifestIcon";

type Kind = ExtensionArtifact["kind"];

const KIND_STYLES: Record<Kind, string> = {
  skill: "bg-emerald-500/14 text-emerald-700 dark:text-emerald-300",
  plugin: "bg-violet-500/14 text-violet-700 dark:text-violet-300",
  mcp: "bg-sky-500/14 text-sky-700 dark:text-sky-300",
};

export function ExtensionIdentityIcon({
  kind,
  name,
  manifest,
  plugin,
  compact = false,
}: {
  kind: Kind;
  name: string;
  manifest?: Record<string, unknown> | null;
  plugin?: Plugin;
  compact?: boolean;
}) {
  const size = compact ? "h-7 w-7 rounded-lg" : "h-10 w-10 rounded-xl";
  const customIcon = manifestIcon(manifest);
  const renderedManifestIcon = customIcon ? renderManifestIcon(customIcon, compact) : null;

  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden ${size} ${KIND_STYLES[kind]}`}>
      {kind === "plugin" && plugin?.icon ? (
        <PluginIcon plugin={plugin} className={compact ? "h-4 w-4" : "h-5 w-5"} size={compact ? 16 : 20} />
      ) : renderedManifestIcon ? (
        renderedManifestIcon
      ) : (
        <Avatar
          variant="bauhaus"
          name={`${kind}:${name}`}
          size={compact ? 28 : 40}
          square
        />
      )}
    </span>
  );
}

function renderManifestIcon(icon: string, compact: boolean) {
  if (/^(https?:|data:)/i.test(icon)) {
    return <img src={icon} alt="" className={`${compact ? "h-4 w-4" : "h-5 w-5"} object-contain`} />;
  }
  if (!icon.includes("/") && !/\.(png|svg|jpe?g|gif|webp|ico)$/i.test(icon)) {
    return <span className="leading-none" style={{ fontSize: compact ? 15 : 20 }}>{icon}</span>;
  }
  return null;
}
