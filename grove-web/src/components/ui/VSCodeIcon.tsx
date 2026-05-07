/**
 * VSCode-style file icon component
 * Uses vscode-icons from CDN
 */

import { useState } from 'react';
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from 'vscode-icons-js';

interface VSCodeIconProps {
  filename: string;
  isFolder?: boolean;
  isOpen?: boolean;
  size?: number;
  className?: string;
}

const ICON_CDN_BASE = 'https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons@master/icons';

export function VSCodeIcon({
  filename,
  isFolder = false,
  isOpen = false,
  size = 16,
  className = ''
}: VSCodeIconProps) {
  let iconName: string;

  if (isFolder) {
    iconName = (isOpen ? getIconForOpenFolder(filename) : getIconForFolder(filename)) || 'default_folder.svg';
  } else {
    iconName = getIconForFile(filename) || 'default_file.svg';
  }

  const iconUrl = `${ICON_CDN_BASE}/${iconName}`;

  // Track which URL last failed to load. Comparing to the current
  // `iconUrl` derives `hasError` without an effect — a useEffect that
  // calls setHasError would trip the project's `react-hooks/set-state-
  // in-effect` lint rule and also race with rapid prop changes.
  // Mutating `style.display` from onError gets clobbered by React's
  // next reconcile, so we render `null` instead.
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
        display: 'inline-block',
        verticalAlign: 'middle',
        flexShrink: 0,
      }}
    />
  );
}
