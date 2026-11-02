/** The icon a manifest declares: top-level `icon`, else the first `icons[].src`. */
export function manifestIcon(manifest?: Record<string, unknown> | null) {
  if (!manifest) return null;
  if (typeof manifest.icon === "string" && manifest.icon.trim()) return manifest.icon.trim();
  if (Array.isArray(manifest.icons)) {
    const first = manifest.icons.find((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).src === "string") as Record<string, unknown> | undefined;
    if (typeof first?.src === "string") return first.src;
  }
  return null;
}
