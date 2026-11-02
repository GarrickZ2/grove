import type { CSSProperties } from "react";
import type { Theme } from "../../context/ThemeContext";

/**
 * The theme's CSS variables, matching what ThemeContext writes on <html>.
 */
export function themePreviewStyle(theme: Theme): CSSProperties {
  const c = theme.colors;
  return {
    "--color-bg": c.bg,
    "--color-bg-secondary": c.bgSecondary,
    "--color-bg-tertiary": c.bgTertiary,
    "--color-border": c.border,
    "--color-text": c.text,
    "--color-text-muted": c.textMuted,
    "--color-highlight": c.highlight,
    "--color-accent": c.accent,
    "--color-success": c.success,
    "--color-warning": c.warning,
    "--color-error": c.error,
    "--color-info": c.info,
    "--grove-text": c.text,
    "--grove-bg": c.bg,
    "--agent-monochrome-icon-filter": theme.isLight ? "brightness(0)" : "brightness(0) invert(1)",
  } as CSSProperties;
}

/**
 * Previews a theme across the whole window (sidebar included) by writing its
 * variables on <html>, like ThemeContext does. Returns a function that puts
 * back exactly what was there, so the saved theme is never touched.
 */
export function applyThemePreview(theme: Theme): () => void {
  const root = document.documentElement;
  const vars = themePreviewStyle(theme) as Record<string, string>;
  const previous = Object.keys(vars).map((name) => [name, root.style.getPropertyValue(name)] as const);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  return () => {
    for (const [name, value] of previous) {
      // If the real theme changed meanwhile (e.g. the card was clicked), keep it.
      if (root.style.getPropertyValue(name) !== vars[name]) continue;
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
  };
}
