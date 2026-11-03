import { getApiBaseUrl } from "../../api/client";

// Default sandbox applied to `<iframe>` elements rendered from markdown when
// the author didn't specify one. Mirrors PREVIEW_IFRAME_SANDBOX in
// previewRenderers.tsx so markdown-embedded HTML and standalone HTML files
// behave the same way: scripts + popups allowed, but no same-origin access.
const IFRAME_DEFAULT_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

// Letting a frame drive the top-level page enables phishing redirects from any
// source, so these are dropped regardless of where the frame comes from.
const TOP_NAVIGATION_TOKENS = new Set([
  "allow-top-navigation",
  "allow-top-navigation-by-user-activation",
  "allow-top-navigation-to-custom-protocols",
]);

function originOf(url: string): string | null {
  try {
    return new URL(url, window.location.origin).origin;
  } catch {
    return null;
  }
}

/** True unless `src` is an http(s) URL on an origin other than Grove's own. */
function isGroveOrigin(src: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(src, window.location.origin);
  } catch {
    return true;
  }
  // blob:, data:, about: and friends inherit or share the embedding origin.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  const groveOrigins = [window.location.origin, originOf(getApiBaseUrl() || window.location.origin)];
  return groveOrigins.includes(parsed.origin);
}

/**
 * Sandbox for a markdown-authored iframe. Markdown comes from agents and
 * repositories, so it must not grant a Grove-origin document same-origin
 * access: that would let worktree HTML read Grove's credentials and call its
 * API. External embeds keep `allow-same-origin`, which only grants their own
 * origin and is required by many players and design tools.
 */
export function markdownIframeSandbox(src: string, authored: string | undefined): string {
  if (authored === undefined) return IFRAME_DEFAULT_SANDBOX;
  const sameOrigin = isGroveOrigin(src);
  return authored
    .split(/\s+/)
    .filter((token) => {
      const lower = token.toLowerCase();
      if (!lower || TOP_NAVIGATION_TOKENS.has(lower)) return false;
      return !(sameOrigin && lower === "allow-same-origin");
    })
    .join(" ");
}
