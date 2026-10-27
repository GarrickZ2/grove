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
