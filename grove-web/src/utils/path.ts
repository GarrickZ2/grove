/**
 * Shorten an absolute path by replacing the home directory prefix with ~.
 *
 * Examples:
 *   "/Users/alex/projects/demo" → "~/projects/demo"
 *   "/tmp/other"                → "/tmp/other"
 */
export function shortenPath(path: string): string {
  // The API server runs on the same machine, so we can detect
  // the home directory from common path patterns.
  // Match /Users/<user>/ (macOS) or /home/<user>/ (Linux)
  const homeMatch = path.match(/^(\/(?:Users|home)\/[^/]+)/);
  if (homeMatch) {
    return "~" + path.slice(homeMatch[1].length);
  }
  return path;
}
