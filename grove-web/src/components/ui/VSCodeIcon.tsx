/**
 * Material Icon Theme file icon component.
 *
 * Backed by the `material-icon-theme` npm package (the data source behind
 * the popular VS Code extension). Loads SVGs from jsdelivr against the
 * pinned package version. Light/dark variant is picked from the active
 * Grove theme's background luminance — material ships `_light.svg`
 * companions for icons that would disappear against a light surface
 * (Jinja, Mocha, …).
 *
 * Lookup logic and CDN plumbing live in `./iconUrl.ts` so raw-DOM call
 * sites can use the same matcher without paying for the React wrapper.
 */

import { useState } from "react";

import { useTheme } from "../../context";
import { iconUrlForFile } from "./iconUrl";

interface VSCodeIconProps {
  filename: string;
  isFolder?: boolean;
  isOpen?: boolean;
  size?: number;
  className?: string;
}

/** Crude luminance check on `#rrggbb`: average of R/G/B. */
function isLightHex(hex: string): boolean {
  if (!hex || hex[0] !== "#" || hex.length !== 7) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r + g + b) / 3 > 127;
}

export function VSCodeIcon({
  filename,
  isFolder = false,
  isOpen = false,
  size = 16,
  className = "",
}: VSCodeIconProps) {
  const { theme } = useTheme();
  const light = isLightHex(theme.colors.bg);
  const iconUrl = iconUrlForFile(filename, { isFolder, isOpen, light });

  // Track which URL last failed to load. Comparing to the current
  // `iconUrl` derives `hasError` without an effect — a useEffect that
  // calls setHasError would trip the project's `react-hooks/set-state-
  // in-effect` lint rule and also race with rapid prop changes.
  const [errorUrl, setErrorUrl] = useState<string | null>(null);
  if (errorUrl === iconUrl) return null;

  return (
    <img
      src={iconUrl}
      alt={filename}
      width={size}
      height={size}
      className={className}
      // Hide the broken-image glyph if the CDN is blocked / offline.
      // Surrounding label text still conveys the file's identity.
      onError={() => setErrorUrl(iconUrl)}
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
    />
  );
}
