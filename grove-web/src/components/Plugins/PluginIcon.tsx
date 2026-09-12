import { useEffect, useState } from "react";
import { Puzzle } from "lucide-react";
import type { Plugin } from "../../api/plugins";
import { ensurePluginAssetSession } from "./pluginAssetSession";

/** A manifest `icon` value is an image if it has an image extension or a path
 *  separator; otherwise it's treated as text (an emoji). */
const IMG_RE = /\.(png|svg|jpe?g|gif|webp|ico)$/i;

/**
 * Renders a plugin's icon: a shipped image (`"icon.png"` / `"assets/x.svg"`,
 * served via the plugin's /asset route), an emoji (`"🧩"`), or — when the
 * manifest declares none — a default puzzle glyph. `className` sizes the box
 * (image + fallback); `size` is the emoji font size in px.
 */
export function PluginIcon({
  plugin,
  className = "h-4 w-4",
  size = 16,
}: {
  plugin: Pick<Plugin, "id" | "icon">;
  className?: string;
  size?: number;
}) {
  const icon = plugin.icon;
  const isImage = Boolean(icon && (IMG_RE.test(icon) || icon.includes("/")));
  const [assetSession, setAssetSession] = useState<{ pluginId: string; token: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!isImage) return;
    void ensurePluginAssetSession(plugin.id)
      .then((token) => {
        if (!cancelled) setAssetSession({ pluginId: plugin.id, token });
      })
      .catch(() => {
        // Keep the safe fallback visible; a later mount can retry.
      });
    return () => {
      cancelled = true;
    };
  }, [plugin.id, isImage]);

  if (icon && (IMG_RE.test(icon) || icon.includes("/"))) {
    if (assetSession?.pluginId !== plugin.id) return <Puzzle className={className} />;
    const src = `/api/v1/plugin-assets/${assetSession.token}/${plugin.id}/${icon
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    return <img src={src} alt="" className={`${className} object-contain`} />;
  }
  if (icon) {
    return (
      <span
        className={`${className} inline-flex items-center justify-center leading-none`}
        style={{ fontSize: size }}
      >
        {icon}
      </span>
    );
  }
  return <Puzzle className={className} />;
}
