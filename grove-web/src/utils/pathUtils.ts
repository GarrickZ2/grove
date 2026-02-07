/**
 * Path utility functions for smart path compression and display
 */

/**
 * Truncate a string to max length with ellipsis
 * @param s - String to truncate
 * @param maxLen - Maximum length
 * @returns Truncated string with "…" if needed
 */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) {
    return s;
  }
  return s.slice(0, maxLen - 1) + "…";
}

/**
 * Shorten path by replacing HOME with ~
 * @param path - Path to shorten
 * @returns Path with ~ prefix if applicable
 */
export function shortenPath(path: string): string {
  // Match /Users/<user>/ (macOS) or /home/<user>/ (Linux)
  const homeMatch = path.match(/^(\/(?:Users|home)\/[^/]+)/);
  if (homeMatch) {
    return "~" + path.slice(homeMatch[1].length);
  }
  return path;
}

/**
 * Smart path compression: progressively abbreviate directories from left to right
 * until the path fits within maxLen. Keep filename (last segment) intact.
 *
 * Example: `/Users/user/projects/service/media_handler/music_handler.go`
 *   1. Replace home: `~/projects/service/media_handler/music_handler.go`
 *   2. If still too long, compress first dir: `~/p/service/media_handler/music_handler.go`
 *   3. Compress second dir: `~/p/s/media_handler/music_handler.go`
 *   4. And so on until it fits...
 *
 * If all dirs compressed and still too long, truncate with "…"
 *
 * @param path - Path to compress
 * @param maxLen - Maximum length
 * @returns Compressed path
 */
export function compactPath(path: string, maxLen: number): string {
  // First replace home directory with ~
  const shortenedPath = shortenPath(path);

  if (shortenedPath.length <= maxLen) {
    return shortenedPath;
  }

  const parts = shortenedPath.split("/").filter(p => p !== ""); // Filter empty strings
  if (parts.length <= 1) {
    return truncate(shortenedPath, maxLen);
  }

  // Try compressing directories from left to right
  const filename = parts[parts.length - 1];
  const dirs = parts.slice(0, parts.length - 1);

  // Progressively compress from left to right
  for (let compressCount = 1; compressCount <= dirs.length; compressCount++) {
    const compressedDirs = dirs.map((dir, index) =>
      index < compressCount ? dir.charAt(0) : dir
    );
    const candidate = `${compressedDirs.join("/")}/${filename}`;

    if (candidate.length <= maxLen) {
      return candidate;
    }
  }

  // All dirs compressed, still too long - truncate
  const allCompressed = `${dirs.map((d) => d.charAt(0)).join("/")}/${filename}`;
  return truncate(allCompressed, maxLen);
}
