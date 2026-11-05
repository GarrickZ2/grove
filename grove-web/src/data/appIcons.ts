import catalog from '../../../src-tauri/icons/variants/catalog.json?raw';

export interface AppIconDesign {
  id: string;
  name: string;
  description: string;
}
export const APP_ICON_DESIGNS: AppIconDesign[] = JSON.parse(catalog);
export const APP_APPEARANCE_CHANGED_EVENT = 'grove:appearance-changed';

export function normalizeAppIconStyle(style: unknown): string {
  return APP_ICON_DESIGNS.some((design) => design.id === style) ? String(style) : 'classic';
}
export function appIconAssetUrl(style: string, isLight: boolean): string {
  return `/app-icons/${normalizeAppIconStyle(style)}-${isLight ? 'light' : 'dark'}.svg`;
}

/** Installed-app assets for an icon; the same key is read by `public/boot-theme.js`. */
export function pwaIconKey(style: string, isLight: boolean): string {
  return `${normalizeAppIconStyle(style)}-${isLight ? 'light' : 'dark'}`;
}
export function pwaTouchIconUrl(key: string): string {
  return `/app-icons/pwa/${key}.png`;
}
export function pwaManifestUrl(key: string): string {
  return `/app-icons/pwa/${key}.webmanifest`;
}
