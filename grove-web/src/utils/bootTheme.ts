const BOOT_THEME_KEY = "grove:boot-theme";
const BOOT_THEME_VARS = [
  "--color-bg", "--color-bg-secondary", "--color-bg-tertiary",
  "--color-border", "--color-text", "--color-text-muted", "--color-highlight",
];

function currentBootTheme(): string {
  const root = document.documentElement;
  const vars = Object.fromEntries(BOOT_THEME_VARS.map((name) => [name, root.style.getPropertyValue(name)]));
  return JSON.stringify({ light: root.dataset.theme === "light", vars });
}

/** Keep the applied theme for `public/boot-theme.js` to paint with next load. */
export function rememberBootTheme() {
  try {
    localStorage.setItem(BOOT_THEME_KEY, currentBootTheme());
  } catch {
    // Only the first paint of the next load depends on this.
  }
}

/** A URL on another origin that opens in this window's theme. */
export function withBootTheme(url: string): string {
  return `${url}#grove-boot=${encodeURIComponent(currentBootTheme())}`;
}
