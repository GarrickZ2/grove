/**
 * VSCode-style file icon component
 * Uses vscode-icons from CDN
 */

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

  return (
    <img
      src={iconUrl}
      alt={filename}
      width={size}
      height={size}
      className={className}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        flexShrink: 0,
      }}
    />
  );
}
