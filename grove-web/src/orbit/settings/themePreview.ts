import type { CSSProperties } from "react";
import type { Theme } from "../../context/ThemeContext";

/**
 * The theme's CSS variables, matching what ThemeContext writes on <html>.
 * Set on the Settings root to preview a theme there only, without saving.
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
