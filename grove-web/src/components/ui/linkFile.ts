// Helpers for the `.link.json` sidecar format used by Artifacts / Shared
// Assets. A link file is plain JSON on disk — this module centralises
// detection, display name and content parsing so the rest of the UI can
// treat it uniformly.

export const LINK_SUFFIX = ".link.json";

export interface LinkFileContent {
  name: string;
  url: string;
  description?: string;
  created_at?: string;
}

export function isLinkFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(LINK_SUFFIX);
}

/** Display name = filename minus the `.link.json` suffix. */
export function linkDisplayName(filename: string): string {
  if (!isLinkFile(filename)) return filename;
  return filename.slice(0, filename.length - LINK_SUFFIX.length);
}

/** Parse link-file JSON, returning null on malformed input. */
export function parseLinkFile(raw: string): LinkFileContent | null {
  try {
    const obj = JSON.parse(raw) as Partial<LinkFileContent>;
    if (typeof obj?.url === "string" && typeof obj?.name === "string") {
      return obj as LinkFileContent;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Render "example.com" from a URL; returns the raw url on parse failure. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
