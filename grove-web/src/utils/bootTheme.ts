const BOOT_THEME_KEY = "grove:boot-theme";
const BOOT_ICON_KEY = "grove:boot-icon";
const BOOT_THEME_VARS = [
  "--color-bg", "--color-bg-secondary", "--color-bg-tertiary",
  "--color-border", "--color-text", "--color-text-muted", "--color-highlight",
];

function currentBootTheme(): string {
  const root = document.documentElement;
  const vars = Object.fromEntries(BOOT_THEME_VARS.map((name) => [name, root.style.getPropertyValue(name)]));
  return JSON.stringify({ light: root.dataset.theme === "light", vars });
}

/**
 * The browser paints its own chrome from this: Safari's bars and the column
 * iPhone Duo's outer screen keeps beside the page, Android's title bar.
 * `public/boot-theme.js` does the same before first paint.
 */
export function syncThemeColor(color: string) {
  document.querySelector("meta[name='theme-color']")?.setAttribute("content", color);
}

/** Keep the applied theme for `public/boot-theme.js` to paint with next load. */
export function rememberBootTheme() {
  try {
    localStorage.setItem(BOOT_THEME_KEY, currentBootTheme());
  } catch {
    // Only the first paint of the next load depends on this.
  }
}

/** Keep the installed-app icon for `public/boot-theme.js` to link next load. */
export function rememberBootIcon(icon: string) {
  try {
    localStorage.setItem(BOOT_ICON_KEY, icon);
  } catch {
    // The page falls back to the default icon until the config loads.
  }
}

/** A URL on another origin that opens in this window's theme. */
export function withBootTheme(url: string): string {
  return `${url}#grove-boot=${encodeURIComponent(currentBootTheme())}`;
}
